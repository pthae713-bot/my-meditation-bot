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

/**
 * ၁။ Telegram ဆီကနေ သီချင်းအသစ်တွေရှိရင် အကုန်ဒေါင်းယူမည့် Function
 */
async function syncTelegramSongs() {
    console.log("📡 Checking for new songs from Telegram...");
    try {
        const updates = await bot.telegram.getUpdates({ offset: -100 });
        const audioUpdates = updates.filter(u => u.message && u.message.audio);

        for (const update of audioUpdates) {
            const file = update.message.audio;
            const fileName = file.file_name || `track_${file.file_unique_id}.mp3`;
            const savePath = path.join(__dirname, 'songs', fileName);

            if (!fs.existsSync(savePath)) {
                console.log(`📥 Downloading: ${fileName}`);
                const link = await bot.telegram.getFileLink(file.file_id);
                const response = await axios({ url: link.href, responseType: 'stream' });
                const writer = fs.createWriteStream(savePath);
                response.data.pipe(writer);
                await new Promise(r => writer.on('finish', r));
            }
        }
    } catch (e) {
        console.log("Note: Telegram offset might be expired or no new messages.");
    }
}

// ၂။ သီချင်းအရှည်တိုင်းတာခြင်း
async function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) reject(err);
            resolve(metadata.format.duration);
        });
    });
}

// ၃။ Video Render & Loop Logic (၁ နာရီကျော်အောင် တွက်ချက်သည်)
async function processQueue() {
    // ပထမဆုံး Telegram က သီချင်းတွေကို အရင်စုဆောင်းသည်
    await syncTelegramSongs();

    const songs = fs.readdirSync('./songs').filter(f => f.endsWith('.mp3')).sort();
    if (songs.length === 0) return console.log("📭 No songs available to process.");

    const currentSong = songs[0];
    const audioPath = path.join(__dirname, 'songs', currentSong);
    const title = currentSong.replace('.mp3', '');

    try {
        await bot.telegram.sendMessage(ADMIN_ID, `🎬 Processing: ${title}`);
        const duration = await getAudioDuration(audioPath);
        
        // Pexels ပုံယူခြင်း
        const imgUrl = await axios.get(`https://api.pexels.com/v1/search?query=meditation&per_page=1`, {
            headers: { 'Authorization': process.env.PEXELS_KEY }
        }).then(r => r.data.photos[0].src.large2x);
        
        const imgPath = path.join(__dirname, 'images', 'bg.jpg');
        const writer = fs.createWriteStream(imgPath);
        (await axios({url: imgUrl, responseType: 'stream'})).data.pipe(writer);
        await new Promise(r => writer.on('finish', r));

        // Video Base လုပ်ခြင်း
        const baseVideo = await renderBase(audioPath, imgPath);
        
        // ၁ နာရီကျော်အောင် Loop ပတ်ခြင်း
        const loopCount = Math.ceil(3600 / duration);
        const targetDuration = 3600 + (Math.floor(Math.random() * 120) + 60);
        const finalVideo = path.join(__dirname, 'output', 'final_long.mp4');

        await new Promise((resolve, reject) => {
            ffmpeg(baseVideo).inputOptions([`-stream_loop ${loopCount}`])
                .outputOptions(['-c copy', `-t ${targetDuration}`])
                .on('end', resolve).on('error', reject).save(finalVideo);
        });

        // YouTube တင်ခြင်း
        const videoUrl = await uploadVideo(finalVideo, title);
        await bot.telegram.sendMessage(ADMIN_ID, `✅ Done! Video uploaded: ${videoUrl}`);

        // အောင်မြင်မှသာ အသုံးပြုခဲ့သော သီချင်းကို ဖျက်သည်
        fs.removeSync(audioPath);
        fs.emptyDirSync('./temp');
        fs.emptyDirSync('./output');

    } catch (err) {
        console.error(err);
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error: ${err.message}`);
    }
}

// (renderBase နှင့် uploadVideo function များသည် အရင် Version အတိုင်းဖြစ်သည်)
async function renderBase(audioPath, imagePath) {
    const outPath = path.join(__dirname, 'temp', `base.mp4`);
    return new Promise((resolve, reject) => {
        ffmpeg().input(imagePath).inputOptions(['-loop 1']).input(audioPath)
          .complexFilter(["[0:v]zoompan=z='min(zoom+0.001,1.3)':d=1:x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2',scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080[bg]"])
          .outputOptions(['-map [bg]', '-map 1:a', '-pix_fmt yuv420p', '-shortest'])
          .on('end', () => resolve(outPath)).on('error', reject).save(outPath);
    });
}

async function uploadVideo(filePath, title) {
    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: { title: `${title} | Relaxing Meditation`, categoryId: '10' },
            status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(filePath) }
    });
    return `https://youtu.be/${res.data.id}`;
}

if (process.env.RUN_WORKFLOW === 'true') { processQueue(); } else { bot.launch(); }