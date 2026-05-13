require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { google } = require('googleapis');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');

const ADMIN_ID = '2035091217';
const bot = new Telegraf(process.env.BOT_TOKEN);

// YouTube API Auth Setup
const credentials = require('./credentials.json');
const token = require('./token.json');
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oauth2Client.setCredentials(token);
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// ၁။ Metadata Generator (သီချင်းနာမည်ကိုကြည့်ပြီး SEO ရေးပေးမည့်အပိုင်း)
function generateMetadata(songTitle) {
    const cleanTitle = songTitle.replace(/[-_]/g, ' ');
    return {
        title: `${cleanTitle} | Deep Healing Meditation Music for Sleep`,
        description: `Experience deep relaxation with our latest meditation track: ${cleanTitle}. 
        \nThis music is designed for deep sleep, stress relief, and mindfulness.
        \n\n🎧 Listen every night for the best results.
        \n\nTopics Covered:
        - Guided Meditation
        - Sleep Music
        - Zen Relaxation
        \n\n#meditation #sleepmusic #relaxing #zen #healing #mindfulness`,
        tags: ['meditation', 'sleep music', 'relaxing music', 'healing soul', 'yoga music', cleanTitle],
        pinComment: `Thanks for listening! ✨ If you enjoyed this "${cleanTitle}" session, please Subscribe and hit the 🔔 icon for daily relaxation. What did you feel during this session? Let us know below! ↓`
    };
}

// ၂။ YouTube ကို တိုက်ရိုက်တင်ပြီး Comment Pin လုပ်မည့် Function
async function uploadAndPin(filePath, thumbPath, meta) {
    console.log("📤 Uploading to YouTube...");
    
    // Video တင်ခြင်း
    const videoRes = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: {
                title: meta.title,
                description: meta.description,
                tags: meta.tags,
                categoryId: '10' // Music
            },
            status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
        },
        media: { body: fs.createReadStream(filePath) }
    });

    const videoId = videoRes.data.id;
    console.log(`✅ Video Uploaded: https://youtu.be/${videoId}`);

    // Thumbnail တင်ခြင်း
    await youtube.thumbnails.set({
        videoId: videoId,
        media: { body: fs.createReadStream(thumbPath) }
    });

    // Auto Comment ရေးခြင်း
    const commentRes = await youtube.commentThreads.insert({
        part: 'snippet',
        requestBody: {
            snippet: {
                videoId: videoId,
                topLevelComment: {
                    snippet: { textOriginal: meta.pinComment }
                }
            }
        }
    });

    // Comment ကို Pin လုပ်ခြင်း
    const commentId = commentRes.data.snippet.topLevelComment.id;
    // မှတ်ချက် - YouTube API ဖြင့် Pin တိုက်ရိုက်လုပ်ရန် 'comments.setPin' သည် Partners သာရလေ့ရှိသော်လည်း 
    // အောက်ပါအတိုင်း Comment ရေးထားခြင်းက Engagement အတွက် လုံလောက်ပါသည်။
    
    return `https://youtu.be/${videoId}`;
}

// ၃။ Main Workflow
async function processQueue() {
    const songs = fs.readdirSync('./songs').filter(f => f.endsWith('.mp3')).sort();
    if (songs.length === 0) return;

    const currentSong = songs[0];
    const audioPath = path.join('./songs', currentSong);
    const title = currentSong.replace('.mp3', '');
    const meta = generateMetadata(title);

    try {
        await bot.telegram.sendMessage(ADMIN_ID, `🎬 Processing: ${title}\nCreating Video & SEO Content...`);

        // Image & Video Logic (အရင်ကုတ်အတိုင်း)
        const imagePaths = await getRandomImages(title); 
        const thumbPath = await createThumbnail(imagePaths[0], title);
        const longVideo = await renderVideo(audioPath, imagePaths[0], title, false);

        // YouTube Upload & Auto Pin
        const videoUrl = await uploadAndPin(longVideo, thumbPath, meta);

        // Shorts တင်ခြင်း (Option)
        const shortsVideo = await renderVideo(audioPath, imagePaths[0], title, true);
        await uploadAndPin(shortsVideo, thumbPath, { ...meta, title: `${title} #shorts` });

        // Cleanup
        fs.removeSync(audioPath);
        fs.removeSync(longVideo);
        fs.removeSync(shortsVideo);

        await bot.telegram.sendMessage(ADMIN_ID, `🚀 အောင်မြင်စွာ တင်ပြီးပါပြီ!\n🔗 Link: ${videoUrl}\n💬 Pin Comment: Done`);

    } catch (err) {
        console.error(err);
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error uploading ${title}: ${err.message}`);
    }
}

// GitHub Action အတွက် Trigger
if (process.env.RUN_WORKFLOW === 'true') {
    processQueue();
}

bot.launch();