const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const fsExtra = require('fs-extra');

const app = express();
const PORT = 3000;
const TOKEN_DIR = path.join(__dirname, 'tokens');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// Ensure directories exist
fsExtra.ensureDirSync(TOKEN_DIR);
fsExtra.ensureDirSync(UPLOAD_DIR);

// Enable CORS and JSON parsing
app.use(cors(
    {
        origin: 'https://reupvideo.vercel.app', // Thay thế bằng tên miền của bạn trên Vercel

    }
));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const fileNumber = Date.now();
        cb(null, `video_${fileNumber}.mp4`);
    }
});

const upload = multer({ storage });

// Function to get the next token file name
async function getNextTokenFileName() {
    try {
        const files = await fs.promises.readdir(TOKEN_DIR);
        const tokenFiles = files.filter(file => file.startsWith('token') && file.endsWith('.txt'));
        if (tokenFiles.length === 0) {
            return 'token1.txt';
        }
        const lastFile = tokenFiles[tokenFiles.length - 1];
        const lastNumber = parseInt(lastFile.replace('token', '').replace('.txt', ''), 10);
        return `token${lastNumber + 1}.txt`;
    } catch (error) {
        console.error('Error getting next token file name:', error);
        throw new Error('Unable to determine the next token file name.');
    }
}

// Endpoint to save token
app.post('/save-token', async (req, res) => {
    const token = req.body.token;
    if (!token) {
        return res.status(400).send('Token is required.');
    }

    try {
        const fileName = await getNextTokenFileName();
        const filePath = path.join(TOKEN_DIR, fileName);
        const timestamp = new Date().toISOString();
        const content = `Token: ${token}\nTimestamp: ${timestamp}`;
        await fs.promises.writeFile(filePath, content, 'utf8');
        console.log('Token saved.');
        res.json({ fileName });
    } catch (error) {
        console.error('Error saving token:', error);
        res.status(500).send('Error saving token');
    }
});

// Function to validate permissions
async function validatePermissions(token) {
    try {
        const response = await axios.get('https://graph.facebook.com/me/permissions', {
            params: { access_token: token }
        });
        const permissions = response.data.data;
        const requiredPermissions = ['publish_video', 'pages_manage_posts', 'pages_manage_engagement', 'pages_read_engagement', 'pages_read_user_content'];
        const missingPermissions = requiredPermissions.filter(permission =>
            !permissions.some(p => p.permission === permission && p.status === 'granted')
        );
        if (missingPermissions.length > 0) {
            throw new Error(`Missing required permissions: ${missingPermissions.join(', ')}`);
        }
    } catch (error) {
        throw new Error(`Error validating permissions: ${error.message}`);
    }
}

// Endpoint to get fanpages
app.post('/fanpages', async (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.status(400).send('Access token is required.');
    }

    try {
        await validatePermissions(token);

        const response = await axios.get('https://graph.facebook.com/me/accounts', {
            params: {
                access_token: token,
                fields: 'id,name,picture,fan_count,followers_count,access_token'
            }
        });

        if (response.data && response.data.data) {
            console.log('Fanpages fetched successfully.');
            res.json(response.data.data);
        } else {
            res.status(404).send('No fanpages found.');
        }
    } catch (error) {
        console.error('Error fetching fanpages:', error.message);
        res.status(500).send('Error fetching fanpages: ' + error.message);
    }
});

// Helper function to wait for a specific amount of time (in milliseconds)
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Endpoint to upload multiple videos with individual titles and scheduling
app.post('/upload-videos', upload.array('videos'), async (req, res) => {
    const files = req.files;
    const fanpageTokens = JSON.parse(req.body.fanpageTokens);
    const titles = JSON.parse(req.body.titles);
    const interval = parseInt(req.body.interval, 10) * 60000; // Interval in milliseconds

    if (!files || files.length === 0) {
        return res.status(400).send('No video files uploaded.');
    }

    if (!fanpageTokens || fanpageTokens.length === 0) {
        return res.status(400).send('No fanpage tokens provided.');
    }

    if (files.length !== titles.length) {
        return res.status(400).send('Number of titles does not match the number of videos.');
    }

    try {
        console.log(`Number of video files selected: ${files.length}`);
        console.log(`Number of fanpages selected: ${fanpageTokens.length}`);
        console.log(`Video titles: ${titles.join(', ')}`);

        // Function to upload video to all fanpages
        async function uploadToFanpages(file, title) {
            const results = await Promise.all(fanpageTokens.map(async (token) => {
                const form = new FormData();
                form.append('file', fs.createReadStream(file.path));
                form.append('access_token', token);
                form.append('description', title);

                try {
                    const response = await axios.post('https://graph-video.facebook.com/v14.0/me/videos', form, {
                        headers: {
                            ...form.getHeaders(),
                        }
                    });

                    return {
                        token,
                        success: response.status === 200,
                        message: response.status === 200 ? 'Upload successful' : `Failed to upload: ${response.statusText}`
                    };
                } catch (error) {
                    return {
                        token,
                        success: false,
                        message: error.message
                    };
                }
            }));
            return results;
        }

        let currentIndex = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const title = titles[i];

            // Upload video to all fanpages
            const uploadResults = await uploadToFanpages(file, title);

            // Send the result for this video immediately
            res.write(JSON.stringify({
                videoIndex: currentIndex + 1,
                results: uploadResults
            }) + '\n');
            res.flushHeaders();

            currentIndex++;

            // Cleanup: delete the file after upload
            await fs.promises.unlink(file.path);

            // Wait for the specified interval before uploading the next video
            if (i < files.length - 1) {
                await wait(interval);
            }
        }

        res.end();
    } catch (error) {
        console.error('Error uploading videos:', error.message);
        res.status(500).send('Error uploading videos: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
