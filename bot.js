require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { google } = require('googleapis');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const { generateLongTTS } = require('./src/utils');
const { renderSlideshow, loopToOneHour } = require('./src/video_engine');
const { uploadToYouTube } = require('./src/youtube_uploader');
const { generateAiContent } = require('./src/ai_engine');

const ADMIN_ID = process.env.ADMIN_ID || '2035091217';
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'Moonlit Harmony'; // User provided channel name
const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

const LAST_UPDATE_ID_LOG = path.join(__dirname, 'last_update_id.txt');

// --- HELPER FUNCTIONS ---

// နောက်ဆုံး update ID ကို ဖတ်ယူသည်
function getLastUpdateId() {
    if (!fs.existsSync(LAST_UPDATE_ID_LOG)) {
        return 0;
    }
    const data = fs.readFileSync(LAST_UPDATE_ID_LOG, 'utf8');
    return parseInt(data, 10) || 0;
}

// နောက်ဆုံး update ID ကို မှတ်တမ်းတင်သည်
function saveLastUpdateId(id) {
    fs.writeFileSync(LAST_UPDATE_ID_LOG, id.toString());
}

// AI Content logic moved to src/ai_engine.js


// --- MAIN FUNCTIONS ---

async function syncTelegramSongs() {
    try {
        const lastUpdateId = getLastUpdateId();
        const updates = await bot.telegram.getUpdates(lastUpdateId + 1, 100, 0);

        if (updates.length === 0) {
            console.log("No new songs from Telegram.");
            return;
        }

        let newMaxUpdateId = lastUpdateId;
        const downloadPromises = [];

        for (const update of updates) {
            newMaxUpdateId = Math.max(newMaxUpdateId, update.update_id);

            if (update.message && update.message.audio) {
                const audio = update.message.audio;
                const fileName = audio.file_name || `track_${Date.now()}.mp3`;

                const localPath = path.join(__dirname, 'songs', fileName);
                const processedPath = path.join(__dirname, 'songs', 'processed', fileName);

                if (!fs.existsSync(localPath) && !fs.existsSync(processedPath)) {
                    // ဒေါင်းလုဒ် promise တစ်ခု ဖန်တီးပြီး စာရင်းထဲထည့်သည်
                    const downloadPromise = (async () => {
                        try {
                            const fileLink = await bot.telegram.getFileLink(audio.file_id);
                            const response = await axios({ url: fileLink.href, responseType: 'stream' });
                            const writer = fs.createWriteStream(localPath);
                            response.data.pipe(writer);
                            await new Promise((resolve, reject) => {
                                writer.on('finish', resolve);
                                writer.on('error', reject);
                            });
                            console.log(`Downloaded new song: ${fileName}`);
                        } catch (downloadError) {
                            console.error(`Failed to download ${fileName}:`, downloadError.message);
                        }
                    })();
                    downloadPromises.push(downloadPromise);
                }
            }
        }

        // ဒေါင်းလုဒ် promise အားလုံးကို တစ်ပြိုင်နက်တည်း run သည်
        if (downloadPromises.length > 0) {
            console.log(`Starting download of ${downloadPromises.length} new song(s)...`);
            await Promise.all(downloadPromises);
            console.log("All new songs downloaded.");
        }

        // စစ်ဆေးပြီးသမျှထဲက အကြီးဆုံး update ID ကို မှတ်တမ်းတင်သည်
        if (newMaxUpdateId > lastUpdateId) {
            saveLastUpdateId(newMaxUpdateId);
            console.log(`Saved last update ID: ${newMaxUpdateId}`);
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

async function searchAndDownloadImages(query) {
    try {
        const randomPage = Math.floor(Math.random() * 20) + 1;
        const res = await axios.get(
            `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=landscape&per_page=5&page=${randomPage}`,
            { headers: { 'Authorization': process.env.PEXELS_KEY } }
        );

        if (!res.data.photos || res.data.photos.length === 0) {
            console.warn(`No images found for query: "${query}". Falling back to "nature".`);
            return searchAndDownloadImages("nature");
        }

        const urls = res.data.photos.map(p => p.src.large2x);
        const downloadPromises = urls.map((url, i) => {
            const imagePath = path.join(__dirname, 'images', `bg_${i}.jpg`);
            return (async () => {
                const writer = fs.createWriteStream(imagePath);
                const response = await axios({ url, responseType: 'stream' });
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                return imagePath;
            })();
        });
        
        const paths = await Promise.all(downloadPromises);
        console.log(`Successfully downloaded ${paths.length} images for query "${query}".`);
        return paths;
    } catch (e) {
        console.error("Error fetching from Pexels:", e.message);
        return [];
    }
}



// Render and Upload logic moved to src/ modules


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
    const originalTitle = currentSong.replace('.mp3', '').replace(/--/g, '—');

    try {
        // 1. AI content generate လုပ်ခြင်း
        const { youtubeTitle, youtubeDescription, youtubeTags, inspirationalQuote, imageKeywords, guidedMeditationScript } = await generateAiContent(genAI, originalTitle, CHANNEL_NAME);

        // 2. AI keywords ဖြင့် image များ ရှာဖွေ ဒေါင်းလုဒ်လုပ်ခြင်း
        const imagePaths = await searchAndDownloadImages(imageKeywords);
        if (imagePaths.length === 0) throw new Error("No images downloaded from Pexels.");

        // 3. Guided Meditation Script မှ အသံဖိုင်ဖန်တီးခြင်း
        let speechAudioPath = null;
        if (guidedMeditationScript) {
            try {
                console.log("Generating guided meditation audio (Long TTS)...");
                const speechFilePath = path.join(__dirname, 'temp', 'speech.mp3');
                await generateLongTTS(guidedMeditationScript, speechFilePath);
                speechAudioPath = speechFilePath;
                console.log("Guided meditation audio generated successfully.");
            } catch (e) {
                console.warn(`Could not generate speech audio: ${e.message}. Proceeding without guided meditation.`);
            }
        }

        // --- Long Video ---
        console.log("--- Starting Long Video Process ---");
        const thumbPath = await createCanvasThumb(imagePaths[0], youtubeTitle);
        const baseLong = await renderSlideshow(audioPath, speechAudioPath, imagePaths, inspirationalQuote, false);
        const finalLong = await loopToOneHour(baseLong, youtubeTitle);
        const longVideoData = await uploadToYouTube(youtube, finalLong, thumbPath, youtubeTitle, youtubeDescription, youtubeTags, false);
        const longUrl = `https://youtu.be/${longVideoData.id}`;

        // --- Shorts Video ---
        console.log("--- Starting Shorts Video Process ---");
        const shortsDesc = youtubeDescription; // Use the full AI-generated description
        const shortsTags = ['shorts', 'meditation', 'relaxing music', ...youtubeTags.slice(0, 5)];
        // Shorts အတွက် ပုံတစ်ပုံနှင့် quote ကိုသုံးပါ (စကားပြောမပါ)
        const finalShorts = await renderSlideshow(audioPath, null, [imagePaths[0]], inspirationalQuote, true);
        const shortsVideoData = await uploadToYouTube(youtube, finalShorts, null, youtubeTitle, shortsDesc, shortsTags, true);
        const shortsUrl = `https://youtu.be/${shortsVideoData.id}`;

        await bot.telegram.sendMessage(ADMIN_ID,
            `✅ Uploaded!\n🎬 Long: ${longUrl}\n📱 Shorts: ${shortsUrl}`
        );

        // Cleanup and move processed song
        fs.emptyDirSync('./temp');
        fs.emptyDirSync('./images');
        // fs.emptyDirSync('./output'); // Keep output for inspection if needed
        const processedDir = path.join(__dirname, 'songs', 'processed');
        fs.ensureDirSync(processedDir);
        fs.moveSync(audioPath, path.join(processedDir, currentSong), { overwrite: true });
        console.log(`Moved ${currentSong} to processed folder.`);

    } catch (err) {
        console.error("Queue Error:", err);
        await bot.telegram.sendMessage(ADMIN_ID, `❌ Error processing ${originalTitle}: ${err.message}`);
        // Move the problematic song to avoid retrying it indefinitely
        const processedDir = path.join(__dirname, 'songs', 'processed', 'error');
        fs.ensureDirSync(processedDir);
        fs.moveSync(audioPath, path.join(processedDir, currentSong), { overwrite: true });
    }
}

// --- START ---
(async () => {
    try {
        await processQueue();
        // process.exit(0); // Keep the process running for potential future tasks or make it a cron job
    } catch (e) {
        console.error("Fatal Error:", e);
        // process.exit(1);
    }
})();