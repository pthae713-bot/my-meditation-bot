const { google } = require('googleapis');
const fs = require('fs-extra');

async function uploadToYouTube(youtube, filePath, thumbPath, title, description, tags, isShorts = false) {
    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: {
                title: isShorts ? `${title} #shorts` : title,
                description,
                tags,
                categoryId: '10', // Music
                defaultLanguage: 'en',
            },
            status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(filePath) }
    });

    if (!isShorts && thumbPath) {
        try {
            await youtube.thumbnails.set({
                videoId: res.data.id,
                media: { body: fs.createReadStream(thumbPath) }
            });
        } catch (e) {
            console.warn("Thumbnail upload failed:", e.message);
        }
    }
    return res.data;
}

module.exports = { uploadToYouTube };
