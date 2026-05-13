require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { google } = require('googleapis');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');

// ၁။ အခြေခံ Configuration
const ADMIN_ID = process.env.ADMIN_ID || '2035091217';
const bot = new Telegraf(process.env.BOT_TOKEN);

// Folder များ အလိုအလျောက် ဆောက်ခြင်း
const dirs = ['songs', 'images', 'output', 'assets'];
dirs.forEach(dir => fs.ensureDirSync(path.join(__dirname, dir)));

// YouTube API Setup
const credentials = require('./credentials.json');
const token = require('./token.json');
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oauth2Client.setCredentials(token);
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

/**
 * ၂။ Pexels မှ Random ပုံများ ရှာဖွေခြင်း
 */
async function getRandomImages(query) {
    try {
        console.log(`🔍 Searching images for: ${query}`);
        const randomPage = Math.floor(Math.random() * 20) + 1;
        const res = await axios.get(`https://api.pexels.com/v1/search?query=${query}&per_page=10&page=${randomPage}`, {
            headers: { 'Authorization': process.env.PEXELS_KEY }
        });

        if (!res.data.photos || res.data.photos.length === 0) {
            const backupRes = await axios.get(`https://api.pexels.com/v1/search?query=nature+meditation&per_page=10`, {
                headers: { 'Authorization': process.env.PEXELS_KEY }
            });
            return backupRes.data.photos.map(p => p.src.large2x);
        }
        return res.data.photos.map(p => p.src.large2x);
    } catch (e) {
        console.error("Pexels API Error:", e.message);
        return [];
    }
}

/**
 * ၃။ Thumbnail ဖန်တီးခြင်း
 */
async function createThumbnail(imagePath, title) {
    const canvas = createCanvas(1280, 720);
    const ctx = canvas.getContext('2d');
    const img = await loadImage(imagePath);
    ctx.drawImage(img, 0, 0, 1280, 720);
    
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 480, 1280, 240);
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 70px Arial';
    ctx.fillText(title.toUpperCase(), 50, 580);
    
    ctx.font = '35px Arial';
    ctx.fillText("Deep Healing & Relaxing Meditation Music", 50, 650);

    const outPath = path.join(__dirname, 'output', 'thumbnail.jpg');
    fs.writeFileSync(outPath, canvas.toBuffer('image/jpeg'));
    return outPath;
}

/**
 * ၄။ Video Rendering (Looping + Ken Burns Effect)
 */
async function renderVideo(audioPath, imagePaths, outputName, isShorts = false) {
    const outPath = path.join(__dirname, 'output', `${outputName}_${isShorts ? 'shorts' : 'long'}.mp4`);
    const size = isShorts ? '1080x1920' : '1920x1080';
    const duration = isShorts ? '00:00:58' : '01:00:00';

    return new Promise((resolve, reject) => {
        let ff = ffmpeg();
        // ပထမပုံကို Background အနေနဲ့ သုံးမယ်
        ff.input(imagePaths[0]).inputOptions(['-loop 1']);
        ff.input(audioPath).inputOptions(['-stream_loop -1']);
        
        // Assets ရှိမရှိ စစ်ဆေးပြီးမှ ထည့်မယ်
        const logoPath = path.join(__dirname, 'assets', 'logo.png');
        const subPath = path.join(__dirname, 'assets', 'subscribe.png');
        
        let filter = `[0:v]zoompan=z='min(zoom+0.0015,1.5)':d=125:x='iw/2-(iw/zoom)/2':y='ih/2-(ih/zoom)/2',scale=${size.replace('x', ':')}:force_original_aspect_ratio=increase,crop=${size.replace('x', ':')}[bg]`;

        if (fs.existsSync(logoPath) && fs.existsSync(subPath)) {
            ff.input(logoPath).input(subPath);
            filter += `;[bg][2:v]overlay=W-w-20:H-h-20[w1];[w1][3:v]overlay=20:20[final]`;
        } else {
            filter += `[bg]`;
        }

        ff.complexFilter([filter])
          .outputOptions(['-map ' + (filter.includes('final') ? '[final]' : '[bg]'), '-map 1:a', `-t ${duration}`, '-pix_fmt yuv420p', '-shortest'])
          .on('start', cmd => console.log('FFmpeg started...'))
          .on('end', () => resolve(outPath))
          .on('error', reject)
          .save(outPath);
    });
}

/**
 * ၅။ YouTube Upload & Pin Comment
 */
async function uploadToYouTube(videoPath, thumbPath, title, isShorts = false) {
    const cleanTitle = title.replace(/[-_]/g, ' ');
    const meta = {
        title: isShorts ? `${cleanTitle} #shorts #meditation` : `${cleanTitle} | Deep Healing Meditation Music`,
        description: `Relax and find your inner peace with ${cleanTitle}.\n\n#meditation #sleepmusic #relaxing #zen`,
        tags: ['meditation', 'sleep music', 'relaxing', cleanTitle]
    };

    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: { title: meta.title, description: meta.description, tags: meta.tags, categoryId: '10' },
            status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(videoPath) }
    });

    const videoId = res.data.id;
    await youtube.thumbnails.set({ videoId, media: { body: fs.createReadStream(thumbPath) } });

    // Comment ရေးခြင်း
    await youtube.commentThreads.insert({
        part: 'snippet',
        requestBody: {
            snippet: {
                videoId,
                topLevelComment: { snippet: { textOriginal: `Thanks for watching! Please Subscribe for more daily relaxation. ✨` } }
            }
        }
    });

    return `https://youtu.be/${videoId}`;
}

/**
 * ၆။ Main Workflow
 */
async function processQueue() {
    const songs = fs.readdirSync('./songs').filter(f => f.endsWith('.mp3')).sort();
    if (songs.length === 0) return console.log("🎵 No songs in queue.");

    const currentSong = songs[0];
    const audioPath = path.join(__dirname, 'songs', currentSong);
    const title = currentSong.replace('.mp3', '');

    try {
        await bot.telegram.sendMessage(ADMIN_ID, `🎬 Processing: ${title}`);

        const imageUrls = await getRandomImages(title || "nature meditation");
        const imagePaths = [];

        // ပုံဒေါင်းခြင်း
        for (let i = 0; i < 1; i++) { // လက်ရှိ Background တစ်ပုံပဲ သုံးဦးမည်
            const imgPath = path.join(__dirname, 'images', `bg_${i}.jpg`);
            const writer = fs.createWriteStream(imgPath);
            const response = await axios({ url: imageUrls[i], method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);
            await new Promise(r => writer.on('finish', r));
            imagePaths.push(imgPath);
        }

        const thumbPath = await createThumbnail(imagePaths[0], title);
        
        // Long Video တင်ခြင်း
        const longVideo = await renderVideo(audioPath, imagePaths, title, false);
        const longUrl = await uploadToYouTube(longVideo, thumbPath, title, false);

        // Shorts Video တင်ခြင်း
        const shortsVideo = await renderVideo(audioPath, imagePaths, title, true);
        const shortsUrl = await uploadToYouTube(shortsVideo, thumbPath, title, true);

        await bot.telegram.sendMessage(ADMIN_ID, `✅ Success!\n🔗 Long: ${longUrl}\n🔗 Shorts: ${shortsUrl}`);

        // Cleanup
        fs.removeSync(audioPath);
        fs.removeSync(longVideo);
        fs.removeSync(shortsVideo);
        imagePaths.forEach(p => fs.removeSync(p));

    } catch (err) {
        console.error(err);
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error: ${err.message}`);
    }
}

/**
 * ၇။ Bot Launch & Trigger
 */
bot.on('audio', async (ctx) => {
    const file = ctx.message.audio;
    const fileName = file.file_name || `track_${Date.now()}.mp3`;
    const link = await ctx.telegram.getFileLink(file.file_id);
    const downloadPath = path.join(__dirname, 'songs', fileName);
    
    const writer = fs.createWriteStream(downloadPath);
    (await axios({ url: link.href, responseType: 'stream' })).data.pipe(writer);
    ctx.reply(`📥 ${fileName} ကို သိမ်းဆည်းပြီးပါပြီ။`);
});

if (process.env.RUN_WORKFLOW === 'true') {
    processQueue().then(() => console.log("Done."));
} else {
    bot.launch().then(() => console.log("🤖 Bot is active."));
}