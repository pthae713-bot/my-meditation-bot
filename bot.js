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
const oauth2Client = new google.auth.OAuth2(
    credentials.installed.client_id,
    credentials.installed.client_secret,
    credentials.installed.redirect_uris[0]
);
oauth2Client.setCredentials(token);
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

// --- FUNCTIONS ---

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

async function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) reject(err);
            resolve(metadata.format.duration);
        });
    });
}

async function getMultipleImages(query) {
    try {
        const randomPage = Math.floor(Math.random() * 20) + 1;
        const res = await axios.get(
            `https://api.pexels.com/v1/search?query=${query}&per_page=5&page=${randomPage}`,
            { headers: { 'Authorization': process.env.PEXELS_KEY } }
        );
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

// ✅ renderSlideshow - တစ်ကြိမ်သာ declare လုပ်ထားပါတယ် (fixed version)
async function renderSlideshow(audioPath, imagePaths, isShorts = false) {
    const outPath = path.join(__dirname, 'temp', `base_${isShorts ? 's' : 'l'}.mp4`);
    const size = isShorts ? '1080x1920' : '1920x1080';
    const scaleSize = isShorts ? '1080:1920' : '1920:1080';

    return new Promise((resolve, reject) => {
        let ff = ffmpeg();
        imagePaths.forEach(img => ff.input(img).inputOptions(['-loop 1', '-t 12']));
        ff.input(audioPath);

        let filter = imagePaths.map((_, i) =>
            `[${i}:v]scale=${scaleSize}:force_original_aspect_ratio=increase,crop=${scaleSize},zoompan=z='min(zoom+0.001,1.2)':d=300:s=${size}[v${i}]`
        ).join(';');

        filter += ';' + imagePaths.map((_, i) => `[v${i}]`).join('') +
            `concat=n=${imagePaths.length}:v=1:a=0[outv]`;

        ff.complexFilter([filter])
          .outputOptions([
              '-map [outv]',
              `-map ${imagePaths.length}:a`,
              '-pix_fmt yuv420p',
              '-c:v libx264',
              '-preset ultrafast',
              '-shortest'
          ])
          .on('end', () => resolve(outPath))
          .on('error', (err) => {
              console.error("FFmpeg Details:", err.message);
              reject(err);
          })
          .save(outPath);
    });
}

async function loopToOneHour(baseVideoPath, finalName) {
    const outPath = path.join(__dirname, 'output', `${finalName}_long.mp4`);
    const loopCount = 60;
    const targetDuration = 3600 + Math.floor(Math.random() * 120);

    return new Promise((resolve, reject) => {
        ffmpeg(baseVideoPath)
            .inputOptions([`-stream_loop ${loopCount}`])
            .outputOptions(['-c copy', `-t ${targetDuration}`])
            .on('end', () => resolve(outPath))
            .on('error', reject)
            .save(outPath);
    });
}

async function uploadVideo(filePath, thumbPath, title, isShorts = false) {
    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: {
                title: isShorts ? `${title} #shorts #meditation` : `${title} | Relaxing Music`,
                description: isShorts ? `Short meditation. #shorts` : `1-hour session. #meditation`,
                categoryId: '10'
            },
            status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(filePath) }
    });
    if (!isShorts) {
        await youtube.thumbnails.set({
            videoId: res.data.id,
            media: { body: fs.createReadStream(thumbPath) }
        });
    }
    return `https://youtu.be/${res.data.id}`;
}

async function createCanvasThumb(imagePath, title) {
    const canvas = createCanvas(1280, 720);
    const ctx = canvas.getContext('2d');
    const img = await loadImage(imagePath);
    ctx.drawImage(img, 0, 0, 1280, 720);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 500, 1280, 220);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 50px Arial';
    ctx.fillText(title.toUpperCase(), 50, 600);
    const outPath = path.join(__dirname, 'output', 'thumb.jpg');
    fs.writeFileSync(outPath, canvas.toBuffer('image/jpeg'));
    return outPath;
}

async function processQueue() {
    await syncTelegramSongs();
    const songs = fs.readdirSync('./songs').filter(f => f.endsWith('.mp3')).sort();
    if (songs.length === 0) return console.log("No songs to process.");

    const currentSong = songs[0];
    const audioPath = path.join(__dirname, 'songs', currentSong);
    const title = currentSong.replace('.mp3', '');

    try {
        const imagePaths = await getMultipleImages('nature meditation');
        const thumbPath = await createCanvasThumb(imagePaths[0], title);

        const baseLong = await renderSlideshow(audioPath, imagePaths, false);
        const finalLong = await loopToOneHour(baseLong, title);
        const longUrl = await uploadVideo(finalLong, thumbPath, title, false);

        const finalShorts = await renderSlideshow(audioPath, [imagePaths[0]], true);
        const shortsUrl = await uploadVideo(finalShorts, thumbPath, title, true);

        await bot.telegram.sendMessage(ADMIN_ID,
            `✅ Uploaded!\n🎬 Long: ${longUrl}\n📱 Shorts: ${shortsUrl}`
        );

        fs.emptyDirSync('./temp');
        fs.emptyDirSync('./output');
        fs.removeSync(audioPath);
    } catch (err) {
        console.error("Queue Error:", err);
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error: ${err.message}`);
    }
}

// --- START LOGIC ---
processQueue();