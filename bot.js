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

const dirs = ['songs', 'images', 'output', 'assets', 'temp'];
dirs.forEach(dir => fs.ensureDirSync(path.join(__dirname, dir)));

const credentials = require('./credentials.json');
const token = require('./token.json');
const oauth2Client = new google.auth.OAuth2(credentials.installed.client_id, credentials.installed.client_secret, credentials.installed.redirect_uris[0]);
oauth2Client.setCredentials(token);
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// Telegram မှ သီချင်းအသစ်များကို Sync လုပ်ခြင်း
async function syncTelegramSongs() {
    try {
        const updates = await bot.telegram.getUpdates(0, 100, -1);
        for (const update of updates) {
            if (update.message && update.message.audio) {
                const audio = update.message.audio;
                const fileName = audio.file_name || `track_${Date.now()}.mp3`;
                const filePath = path.join(__dirname, 'songs', fileName);
                if (!fs.existsSync(filePath)) {
                    const fileLink = await bot.telegram.getFileLink(audio.file_id);
                    const response = await axios({ url: fileLink.href, responseType: 'stream' });
                    const writer = fs.createWriteStream(filePath);
                    response.data.pipe(writer);
                    await new Promise(r => writer.on('finish', r));
                }
            }
        }
    } catch (e) { console.log("Sync Error:", e.message); }
}

// ပုံများစွာကို တစ်ခါတည်း ဒေါင်းလုဒ်ဆွဲခြင်း (မထပ်စေရန်)
async function getMultipleImages(query) {
    try {
        const randomPage = Math.floor(Math.random() * 10) + 1;
        const res = await axios.get(`https://api.pexels.com/v1/search?query=${query}&per_page=5&page=${randomPage}`, {
            headers: { 'Authorization': process.env.PEXELS_KEY }
        });
        const urls = res.data.photos.map(p => p.src.large2x);
        const paths = [];
        for (let i = 0; i < urls.length; i++) {
            const p = path.join(__dirname, 'images', `bg_${i}.jpg`);
            const writer = fs.createWriteStream(p);
            const response = await axios({ url: urls[i], responseType: 'stream' });
            response.data.pipe(writer);
            await new Promise(r => writer.on('finish', r));
            paths.push(p);
        }
        return paths;
    } catch (e) { return []; }
}

// Slideshow Render လုပ်ခြင်း (ပုံ ၅ ပုံ ပြောင်းသွားမည်)
async function renderSlideshow(audioPath, imagePaths, isShorts = false) {
    const outPath = path.join(__dirname, 'temp', `base_${isShorts ? 's' : 'l'}.mp4`);
    const size = isShorts ? '1080x1920' : '1920x1080';
    
    return new Promise((resolve, reject) => {
        let ff = ffmpeg();
        imagePaths.forEach(img => ff.input(img).inputOptions(['-loop 1', '-t 10'])); // ပုံတစ်ပုံကို ၁၀ စက္ကန့်စီပြမည်
        ff.input(audioPath);

        // ပုံများအကြား Transition နှင့် Zoom Effect
        let filter = imagePaths.map((_, i) => `[${i}:v]scale=${size.replace('x', ':')}:force_original_aspect_ratio=increase,crop=${size.replace('x', ':')},zoompan=z='min(zoom+0.001,1.2)':d=250:s=${size}[v${i}]`).join(';');
        filter += ';' + imagePaths.map((_, i) => `[v${i}]`).join('') + `concat=n=${imagePaths.length}:v=1:a=0[outv]`;

        ff.complexFilter([filter])
          .outputOptions(['-map [outv]', `-map ${imagePaths.length}:a`, '-pix_fmt yuv420p', '-shortest'])
          .on('end', () => resolve(outPath))
          .on('error', reject)
          .save(outPath);
    });
}

// ၁ နာရီစာ Loop ပတ်ခြင်း (Randomized)
async function loopToOneHour(baseVideoPath, audioDuration, finalName) {
    const outPath = path.join(__dirname, 'output', `${finalName}_long.mp4`);
    const loopCount = Math.ceil(3600 / (imagePaths.length * 10)); // ၁ နာရီပြည့်အောင် တွက်ချက်သည်
    const targetDuration = 3600 + Math.floor(Math.random() * 180);

    return new Promise((resolve, reject) => {
        ffmpeg(baseVideoPath)
            .inputOptions([`-stream_loop ${loopCount}`])
            .outputOptions(['-c copy', `-t ${targetDuration}`])
            .on('end', () => resolve(outPath))
            .on('error', reject)
            .save(outPath);
    });
}

// YouTube Upload & Process Queue (ယခင်အတိုင်း)
// ... (uploadVideo, createCanvasThumb, processQueue များအား အထက်ပါ function သစ်များဖြင့် ညှိနှိုင်းသုံးစွဲရန်)