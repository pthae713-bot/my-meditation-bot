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
 * ၁။ Telegram မှ အသစ်ရောက်နေသော သီချင်းများကို Auto-Sync လုပ်ခြင်း
 * ဤအဆင့်သည် PC မဖွင့်ဘဲ GitHub Actions ပေါ်မှာတင် သီချင်းများကို သိမ်းဆည်းပေးမည်။
 */
async function syncTelegramSongs() {
    console.log("📥 Checking for new songs from Telegram...");
    try {
        // Bot ဆီရောက်နေသော updates များကို ရယူသည်
        const updates = await bot.telegram.getUpdates(0, 100, -1);
        
        for (const update of updates) {
            if (update.message && update.message.audio) {
                const audio = update.message.audio;
                const fileName = audio.file_name || `track_${Date.now()}.mp3`;
                const filePath = path.join(__dirname, 'songs', fileName);

                // ဖိုင်မရှိသေးမှ ဒေါင်းမည်
                if (!fs.existsSync(filePath)) {
                    console.log(`Downloading: ${fileName}`);
                    const fileLink = await bot.telegram.getFileLink(audio.file_id);
                    const response = await axios({ url: fileLink.href, responseType: 'stream' });
                    const writer = fs.createWriteStream(filePath);
                    response.data.pipe(writer);
                    await new Promise(r => writer.on('finish', r));
                }
            }
        }
    } catch (e) {
        console.log("Sync Error:", e.message);
    }
}

async function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) reject(err);
            resolve(metadata.format.duration);
        });
    });
}

async function renderBase(audioPath, imagePath, isShorts = false) {
    const outPath = path.join(__dirname, 'temp', `base_${isShorts ? 's' : 'l'}.mp4`);
    const size = isShorts ? '1080x1920' : '1920x1080';
    const duration = isShorts ? 58 : null;

    return new Promise((resolve, reject) => {
        let ff = ffmpeg().input(imagePath).inputOptions(['-loop 1']).input(audioPath);
        let filter = `[0:v]zoompan=z='min(zoom+0.001,1.3)':d=1:x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2',scale=${size.replace('x', ':')}:force_original_aspect_ratio=increase,crop=${size.replace('x', ':')}[bg]`;
        
        let command = ff.complexFilter([filter]).outputOptions(['-map [bg]', '-map 1:a', '-pix_fmt yuv420p', '-shortest']);
        if (duration) command.setDuration(duration);
        
        command.on('end', () => resolve(outPath)).on('error', reject).save(outPath);
    });
}

async function loopToOneHour(baseVideoPath, audioDuration, finalName) {
    const outPath = path.join(__dirname, 'output', `${finalName}_long.mp4`);
    const loopCount = Math.ceil(3600 / audioDuration);
    const randomExtraTime = Math.floor(Math.random() * 120) + 60; 
    const targetDuration = 3600 + randomExtraTime;

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
                title: isShorts ? `${title} #shorts #meditation` : `${title} | Relaxing Sleep Music`, 
                description: isShorts ? `Relax in seconds. #shorts` : `Full 1-hour session. #meditation #sleep`, 
                categoryId: '10' 
            },
            status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(filePath) }
    });
    if (!isShorts) {
        await youtube.thumbnails.set({ videoId: res.data.id, media: { body: fs.createReadStream(thumbPath) } });
    }
    return `https://youtu.be/${res.data.id}`;
}

async function processQueue() {
    // ပထမဆုံး Telegram က သီချင်းအသစ်တွေကို Sync လုပ်မည်
    await syncTelegramSongs();

    const songs = fs.readdirSync('./songs').filter(f => f.endsWith('.mp3')).sort();
    if (songs.length === 0) {
        console.log("No songs available to process.");
        return;
    }

    const currentSong = songs[0];
    const audioPath = path.join(__dirname, 'songs', currentSong);
    const title = currentSong.replace('.mp3', '');

    try {
        const duration = await getAudioDuration(audioPath);
        const imgUrl = await axios.get(`https://api.pexels.com/v1/search?query=meditation&per_page=1`, {
            headers: { 'Authorization': process.env.PEXELS_KEY }
        }).then(r => r.data.photos[0].src.large2x);
        
        const imgPath = path.join(__dirname, 'images', 'bg.jpg');
        const writer = fs.createWriteStream(imgPath);
        (await axios({url: imgUrl, responseType: 'stream'})).data.pipe(writer);
        await new Promise(r => writer.on('finish', r));

        const thumbPath = await createCanvasThumb(imgPath, title);

        const baseLong = await renderBase(audioPath, imgPath, false);
        const finalLong = await loopToOneHour(baseLong, duration, title);
        const longUrl = await uploadVideo(finalLong, thumbPath, title, false);

        const finalShorts = await renderBase(audioPath, imgPath, true);
        const shortsUrl = await uploadVideo(finalShorts, thumbPath, title, true);

        await bot.telegram.sendMessage(ADMIN_ID, `✅ Success!\n🎬 Long: ${longUrl}\n📱 Shorts: ${shortsUrl}`);

        // အသုံးပြုပြီးသော သီချင်းတစ်ပုဒ်တည်းကိုသာ ဖျက်မည်
        fs.emptyDirSync('./temp');
        fs.emptyDirSync('./output');
        fs.removeSync(audioPath);

    } catch (err) {
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error: ${err.message}`);
    }
}

async function createCanvasThumb(imagePath, title) {
    const canvas = createCanvas(1280, 720);
    const ctx = canvas.getContext('2d');
    const img = await loadImage(imagePath);
    ctx.drawImage(img, 0, 0, 1280, 720);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 500, 1280, 220);
    ctx.fillStyle = 'white'; ctx.font = 'bold 50px Arial';
    ctx.fillText(title.toUpperCase(), 50, 600);
    const outPath = path.join(__dirname, 'output', 'thumb.jpg');
    fs.writeFileSync(outPath, canvas.toBuffer('image/jpeg'));
    return outPath;
}

// GitHub Actions ကနေ Run တာဆိုရင် processQueue ကို တိုက်ရိုက်ခေါ်သည်
if (process.env.RUN_WORKFLOW === 'true') { 
    processQueue(); 
} else {
    // Local မှာ PC နဲ့ run ထားချင်ရင် audio listen လုပ်လို့ရအောင် ထားပေးသည်
    bot.on('audio', async (ctx) => {
        ctx.reply("📥 သီချင်းကို လက်ခံရရှိပါတယ်။ GitHub Action အချိန်ကျရင် အလိုအလျောက် သိမ်းဆည်းသွားပါလိမ့်မယ်။");
    });
    bot.launch();
}