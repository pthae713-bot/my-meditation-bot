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

// ✅ Fix: YouTube အတွက် description, tags, comment တို့ကို အလိုအလျောက် ဖန်တီးပေးသည်
function generateContent(title) {
    const cleanTitle = title.replace(/[^a-zA-Z0-9\\s]/g, '').trim();
    const keywords = cleanTitle.split(/\\s+/).filter(w => w.length > 2);
    const hashtags = keywords.map(k => `#${k.replace(/\\s+/g, '')}`).join(' ');

    const description = `✨ ${cleanTitle} | 1-Hour Relaxing Meditation Music ✨

Immerse yourself in this hour-long session of calming meditation music. Titled "${cleanTitle}", this track is designed to help you find your inner peace, reduce stress, and achieve a state of deep relaxation.

Whether you're looking to meditate, focus on work, study, or simply unwind after a long day, this soothing melody provides the perfect background ambiance.

🌿 This music is perfect for:
- Deep Meditation
- Stress and Anxiety Relief
- Yoga and Pilates Sessions
- Sleep and Relaxation
- Studying and Concentration
- Mindfulness and Healing

🔔 Subscribe for more daily relaxing music!

#Meditation #RelaxingMusic #1Hour #YogaMusic #SleepMusic ${hashtags}`.trim();

    const tags = [
        'meditation', 'meditation music', 'relaxing music', 'relaxation music',
        'calm music', 'soothing music', '1 hour meditation music', 'music for meditation',
        'deep meditation music', 'stress relief music', 'yoga music', 'sleep music',
        'healing music', 'mindfulness', 'inner peace', 'asmr',
        ...keywords.map(k => k.toLowerCase())
    ];

    const pinComment = `Thank you for listening! We hope this music helps you find a moment of peace and tranquility in your day. 
What did you feel while listening to "${cleanTitle}"? Let us know in the replies! 👇`.trim();

    return { description, tags, pinComment };
}

// ✅ Fix: သီချင်းအရှည်အတိုင်း ပုံများကို တွက်ချက်ပြသပေးသည်
async function renderSlideshow(audioPath, imagePaths, isShorts = false) {
    const outPath = path.join(__dirname, 'temp', `base_${isShorts ? 's' : 'l'}.mp4`);
    const width  = isShorts ? 1080 : 1920;
    const height = isShorts ? 1920 : 1080;
    
    // သီချင်း duration ကို အတိအကျယူသည်
    const duration = await getAudioDuration(audioPath);
    const n = imagePaths.length;
    // ပုံတစ်ပုံချင်းစီ၏ duration ကို သီချင်းအရှည်နှင့် ညှိသည်
    const imgDuration = duration / n;

    return new Promise((resolve, reject) => {
        let ff = ffmpeg();

        imagePaths.forEach(img => {
            ff.input(img).inputOptions(['-loop 1', `-t ${imgDuration}`]);
        });
        ff.input(audioPath);

        const scaleFilters = imagePaths.map((_, i) =>
            `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
            `crop=${width}:${height},setsar=1,fps=25,format=yuv420p[v${i}]`
        );
        
        const concatInput  = imagePaths.map((_, i) => `[v${i}]`).join('');
        const concatFilter = `${concatInput}concat=n=${n}:v=1:a=0[outv]`;
        
        let filterComplex;
        let outputMaps;

        // Loop လုပ်မည့် video ရှည်အတွက် audio ကို ချောမွေ့စေရန် fade effect ထည့်သွင်းခြင်း
        if (!isShorts) {
            const fadeDuration = 1;
            const fadeStartTime = duration > fadeDuration ? duration - fadeDuration : 0;
            const audioFilter = `[${n}:a]afade=t=in:st=0:d=${fadeDuration},afade=t=out:st=${fadeStartTime}:d=${fadeDuration}[outa]`;
            filterComplex = [...scaleFilters, concatFilter, audioFilter].join(';');
            outputMaps = ['-map [outv]', '-map [outa]'];
        } else {
            filterComplex = [...scaleFilters, concatFilter].join(';');
            outputMaps = ['-map [outv]', `-map ${n}:a`];
        }

        ff.complexFilter(filterComplex)
          .outputOptions([
              ...outputMaps,
              '-c:v libx264',
              '-preset ultrafast',
              '-crf 23',
              '-pix_fmt yuv420p',
              '-c:a aac',
              '-b:a 192k',
              '-shortest',
              '-avoid_negative_ts make_zero'
          ])
          .on('start', cmd => console.log('FFmpeg Render Start'))
          .on('end', () => resolve(outPath))
          .on('error', (err) => reject(err))
          .save(outPath);
    });
}

// Base video ကို တစ်နာရီကျော်ကြာအောင် ချောမွေ့စွာ loop ပြုလုပ်သည်
async function loopToOneHour(baseVideoPath, finalName) {
    const outPath = path.join(__dirname, 'output', `${finalName}_long.mp4`);
    const targetDuration = 3600 + Math.floor(Math.random() * 120);

    return new Promise((resolve, reject) => {
        ffmpeg(baseVideoPath)
            .inputOptions(['-stream_loop -1']) // Target duration ပြည့်အောင် loop ပတ်မည်
            .outputOptions([
                '-c:v libx264',
                '-preset ultrafast',
                '-c:a aac',
                `-t ${targetDuration}`,
                '-pix_fmt yuv420p'
            ])
            .on('end', () => resolve(outPath))
            .on('error', reject)
            .save(outPath);
    });
}

async function uploadVideo(filePath, thumbPath, title, description, tags, isShorts = false) {
    const snippet = {
        title: isShorts ? `${title} #shorts #meditation` : `${title} | Relaxing Music`,
        description: description,
        tags: isShorts ? ['shorts', 'meditation', ...tags.slice(0, 8)] : tags,
        categoryId: '10'
    };

    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: snippet,
            status: { privacyStatus: 'public' }
        },
        media: { body: fs.createReadStream(filePath) }
    });

    if (!isShorts && thumbPath) {
        await youtube.thumbnails.set({
            videoId: res.data.id,
            media: { body: fs.createReadStream(thumbPath) }
        });
    }
    return res.data;
}

// ✅ Fix: Video တင်ပြီးနောက် comment ရေးသားပြီး pin ရန်ကြိုးစားသည်
async function postAndPinComment(videoId, commentText) {
    try {
        const commentRes = await youtube.commentThreads.insert({
            part: 'snippet',
            requestBody: {
                snippet: {
                    videoId: videoId,
                    topLevelComment: {
                        snippet: {
                            textOriginal: commentText
                        }
                    }
                }
            }
        });
        const commentId = commentRes.data.snippet.topLevelComment.id;
        console.log(`Comment posted: ${commentId}. Pinning manually is required.`);
        await bot.telegram.sendMessage(ADMIN_ID, `Comment posted for https://youtu.be/${videoId}. Please pin it manually.`);
    } catch (err) {
        console.error('Error posting comment:', err.message);
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error posting comment: ${err.message}`);
    }
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
    const title = currentSong.replace('.mp3', '').replace(/--/g, '—');

    try {
        const { description, tags, pinComment } = generateContent(title);
        const imagePaths = await getMultipleImages('nature meditation');
        if (imagePaths.length === 0) throw new Error("No images fetched");

        // --- Long Video ---
        const thumbPath = await createCanvasThumb(imagePaths[0], title);
        const baseLong = await renderSlideshow(audioPath, imagePaths, false);
        const finalLong = await loopToOneHour(baseLong, title);
        const longVideoData = await uploadVideo(finalLong, thumbPath, title, description, tags, false);
        const longUrl = `https://youtu.be/${longVideoData.id}`;
        await postAndPinComment(longVideoData.id, pinComment);

        // --- Shorts Video ---
        const shortsDesc = `Enjoy a short moment of peace with "${title}". #shorts #meditation #relaxingmusic`;
        const shortsTags = ['shorts', 'meditation', 'relaxing music', ...tags.slice(0, 5)];
        const finalShorts = await renderSlideshow(audioPath, [imagePaths[0]], true);
        const shortsVideoData = await uploadVideo(finalShorts, null, title, shortsDesc, shortsTags, true);
        const shortsUrl = `https://youtu.be/${shortsVideoData.id}`;

        await bot.telegram.sendMessage(ADMIN_ID,
            `✅ Uploaded!\n🎬 Long: ${longUrl}\n📱 Shorts: ${shortsUrl}`
        );

        fs.emptyDirSync('./temp');
        fs.emptyDirSync('./images');
        fs.emptyDirSync('./output');
        fs.removeSync(audioPath);
    } catch (err) {
        console.error("Queue Error:", err);
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error: ${err.message}`);
    }
}

// --- START ---
(async () => {
    try {
        await processQueue();
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();