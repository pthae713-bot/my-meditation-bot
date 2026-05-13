require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { google } = require('googleapis');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');

const ADMIN_ID = process.env.ADMIN_ID || '2035091217';
const bot = new Telegraf(process.env.BOT_TOKEN);

// Folder Setup
const dirs = ['songs', 'images', 'output', 'assets', 'temp'];
dirs.forEach(dir => fs.ensureDirSync(path.join(__dirname, dir)));

const credentials = require('./credentials.json');
const token = require('./token.json');
const oauth2Client = new google.auth.OAuth2(credentials.installed.client_id, credentials.installed.client_secret, credentials.installed.redirect_uris[0]);
oauth2Client.setCredentials(token);
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

/**
 * ၁။ Rendering ကို သီချင်းအရှည်အတိုင်းပဲ အရင်လုပ်မည် (အမြန်ဆုံးနည်းလမ်း)
 */
async function renderShortBase(audioPath, imagePath, outputName, isShorts = false) {
    const outPath = path.join(__dirname, 'temp', `base_${isShorts ? 's' : 'l'}.mp4`);
    const size = isShorts ? '1080x1920' : '1920x1080';

    return new Promise((resolve, reject) => {
        let ff = ffmpeg().input(imagePath).inputOptions(['-loop 1']).input(audioPath);
        
        // Ken Burns Effect (Smooth Zoom)
        let filter = `[0:v]zoompan=z='min(zoom+0.001,1.3)':d=1:x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2',scale=${size.replace('x', ':')}:force_original_aspect_ratio=increase,crop=${size.replace('x', ':')}[bg]`;

        ff.complexFilter([filter])
          .outputOptions(['-map [bg]', '-map 1:a', '-pix_fmt yuv420p', '-shortest'])
          .on('end', () => resolve(outPath))
          .on('error', reject)
          .save(outPath);
    });
}

/**
 * ၂။ Base Video ကို ၁ နာရီစာဖြစ်အောင် Loop လုပ်မည် (Rendering မဟုတ်ဘဲ Copy လုပ်ခြင်းဖြစ်၍ အလွန်မြန်သည်)
 */
async function loopToHour(baseVideoPath, finalName) {
    const outPath = path.join(__dirname, 'output', `${finalName}_long.mp4`);
    return new Promise((resolve, reject) => {
        // ၁ နာရီစာရအောင် loop ပတ်မည် (၅ မိနစ်သီချင်းဆိုလျှင် ၁၂ ခါ loop ပတ်မည်)
        ffmpeg(baseVideoPath)
            .inputOptions(['-stream_loop 12']) // ၁၂ ခါဆိုလျှင် ၁ နာရီဝန်းကျင်ရသည်
            .outputOptions(['-c copy', '-t 01:00:00']) // Rendering မလုပ်ဘဲ copy ပဲလုပ်သဖြင့် ခဏချင်းပြီးသည်
            .on('end', () => resolve(outPath))
            .on('error', reject)
            .save(outPath);
    });
}

// ပုံဒေါင်းခြင်းနှင့် အခြား function များ (အရင် Version အတိုင်း)
async function getRandomImages(query) {
    try {
        const res = await axios.get(`https://api.pexels.com/v1/search?query=${query}&per_page=1`, {
            headers: { 'Authorization': process.env.PEXELS_KEY }
        });
        return res.data.photos[0].src.large2x;
    } catch (e) { return 'https://images.pexels.com/photos/1051838/pexels-photo-1051838.jpeg'; }
}

async function createThumbnail(imagePath, title) {
    const canvas = createCanvas(1280, 720);
    const ctx = canvas.getContext('2d');
    const img = await loadImage(imagePath);
    ctx.drawImage(img, 0, 0, 1280, 720);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 500, 1280, 220);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 60px Arial';
    ctx.fillText(title.toUpperCase(), 50, 600);
    const outPath = path.join(__dirname, 'output', 'thumb.jpg');
    fs.writeFileSync(outPath, canvas.toBuffer('image/jpeg'));
    return outPath;
}

async function uploadToYouTube(filePath, thumbPath, title) {
    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: { title: `${title} | Relaxing Meditation Music`, description: `#meditation #sleep`, categoryId: '10' },
            status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(filePath) }
    });
    await youtube.thumbnails.set({ videoId: res.data.id, media: { body: fs.createReadStream(thumbPath) } });
    return `https://youtu.be/${res.data.id}`;
}

async function processQueue() {
    const songs = fs.readdirSync('./songs').filter(f => f.endsWith('.mp3')).sort();
    if (songs.length === 0) return;

    const currentSong = songs[0];
    const audioPath = path.join(__dirname, 'songs', currentSong);
    const title = currentSong.replace('.mp3', '');

    try {
        await bot.telegram.sendMessage(ADMIN_ID, `🚀 Starting Optimized Process: ${title}`);

        const imgUrl = await getRandomImages(title);
        const imgPath = path.join(__dirname, 'images', 'bg.jpg');
        const writer = fs.createWriteStream(imgPath);
        (await axios({url: imgUrl, responseType: 'stream'})).data.pipe(writer);
        await new Promise(r => writer.on('finish', r));

        const thumbPath = await createThumbnail(imgPath, title);

        // အမြန်နှုန်းအတွက် Rendering ကို သီချင်းအရှည်အတိုင်းပဲ အရင်လုပ်သည်
        const baseVideo = await renderShortBase(audioPath, imgPath, title, false);
        
        // ၁ နာရီစာ ဖြစ်အောင် အမြန်ဆုံး Loop ပတ်သည်
        const finalVideo = await loopToHour(baseVideo, title);

        const videoUrl = await uploadToYouTube(finalVideo, thumbPath, title);

        await bot.telegram.sendMessage(ADMIN_ID, `✅ Done! (Speed Mode)\n🔗 Link: ${videoUrl}`);

        // Cleanup
        fs.removeSync(audioPath);
        fs.emptyDirSync('./temp');
        fs.emptyDirSync('./output');
        fs.emptyDirSync('./images');

    } catch (err) {
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error: ${err.message}`);
    }
}

if (process.env.RUN_WORKFLOW === 'true') {
    processQueue();
} else {
    bot.launch();
}