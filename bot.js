import dotenv from "dotenv"; 
 import fs from "fs"; 
 import path from "path"; 
 import { generateAudio, loopAudio } from "./src/audioGenerator.js"; 
 import { generateVideoFrame, createLongVideo } from "./src/videoGenerator.js"; 
 import { uploadToYouTube, getAuthClient } from "./src/youtubeUploader.js"; 
 import { generateMetadata } from "./src/metadataGenerator.js"; 
 import { PlaylistManager } from "./src/playlistManager.js"; 
 import { sendSuccess, sendNotification, setupTelegramListener } from "./src/telegramBot.js"; 
 
 
 dotenv.config(); 
 
 
 const TEMP_DIR = "./temp"; 
 const VIDEO_DURATION = 3660; // 61 minutes 
 
 
 // Telegram Listener ကို စတင်နှိုးခြင်း 
 setupTelegramListener(); 
 
 
 async function getScheduledTime() { 
   const now = new Date(); 
   const scheduled = new Date(); 
   const currentHour = now.getUTCHours(); 
 
 
   if (currentHour < 12) { 
     scheduled.setUTCHours(12, 0, 0, 0); // ပထမအသုတ် 
   } else { 
     scheduled.setUTCHours(23, 0, 0, 0); // ဒုတိယအသုတ် 
   } 
 
 
   if (scheduled <= now) { 
     scheduled.setDate(scheduled.getDate() + 1); 
   } 
   return scheduled; 
 } 
 
 
 async function main() { 
   console.log("🚀 YouTube Auto-Upload Bot Starting..."); 
   const videoCount = parseInt(process.env.VIDEO_COUNT || "0"); 
   if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true }); 
 
 
   let currentAudioData = null; 
 
 
   try { 
     const shortAudioPath = path.join(TEMP_DIR, "short_audio.wav"); 
     currentAudioData = await generateAudio(shortAudioPath); 
     
     const metadata = generateMetadata(videoCount); 
     metadata.title = `${currentAudioData.trackTitle} | Deep Relaxing Piano & Strings`; 
     
     await sendNotification(`🎬 Starting video generation...\n🎵 <b>${metadata.title}</b>`); 
 
 
     const longAudioPath = path.join(TEMP_DIR, "long_audio.mp3"); 
     await loopAudio(currentAudioData.path, longAudioPath, VIDEO_DURATION); 
 
 
     await generateVideoFrame(path.join(TEMP_DIR, "short_video.mp4"), metadata.videoCategory); 
     const finalVideoPath = path.join(TEMP_DIR, "final_video.mp4"); 
     await createLongVideo(path.join(TEMP_DIR, "short_video.mp4"), longAudioPath, finalVideoPath, VIDEO_DURATION); 
 
 
     const scheduledTime = await getScheduledTime(); 
     const { videoId } = await uploadToYouTube(finalVideoPath, metadata, scheduledTime); 
 
 
     const auth = await getAuthClient(); 
     const playlistManager = new PlaylistManager(auth); 
     const playlistId = await playlistManager.getOrCreatePlaylist(metadata.playlistName); 
     await playlistManager.addToPlaylist(playlistId, videoId); 
 
 
     // --- CLEANUP & AUTO-DELETE SECTION --- 
     console.log("🛠️ Attempting to delete source file..."); 
     const sourceFile = path.resolve(currentAudioData.originalFile); 
 
 
     await sendSuccess(videoId, metadata.title, scheduledTime, metadata.playlistName); 
 
 
     if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true }); 
 
 
     if (fs.existsSync(sourceFile)) { 
         // File Lock ကင်းအောင် ၃ စက္ကန့်စောင့်ပြီးမှ ဖျက်မယ် 
         await new Promise(resolve => setTimeout(resolve, 3000)); 
         fs.unlinkSync(sourceFile); 
         console.log(`🗑️ Source file deleted: ${sourceFile}`); 
     } 
 
 
     console.log(`\n🎉 Process Complete! System exiting...`); 
     process.exit(0); 
 
 
   } catch (error) { 
     console.error("❌ Error:", error.message); 
     await sendNotification(`❌ <b>Upload Failed!</b>\nError: ${error.message}`, true); 
     process.exit(1); 
   } 
 } 
 
 
 main();
        tags: isShorts ? ['shorts', 'meditation', ...tags.slice(0, 8)] : tags,
        categoryId: '10'
    };

    const res = await youtube.videos.insert({
        part: 'snippet,status',
        requestBody: {
            snippet: {
                title: snippet.title,
                description: snippet.description,
                tags: snippet.tags,
                categoryId: snippet.categoryId
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
        } catch (thumbError) {
            console.warn(`⚠️  Thumbnail upload failed for video ID ${res.data.id}: ${thumbError.message}`);
            console.warn("This is likely a YouTube rate limit. The video is uploaded, but you may need to set the thumbnail manually.");
            // Don't re-throw the error, just warn the user and continue.
        }
    }
    return res.data;
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
    const originalTitle = currentSong.replace('.mp3', '').replace(/--/g, '—');

    try {
        // 1. AI content generate လုပ်ခြင်း
        const { youtubeTitle, youtubeDescription, youtubeTags, inspirationalQuote, imageKeywords, guidedMeditationScript } = await generateAiContent(originalTitle);

        // 2. AI keywords ဖြင့် image များ ရှာဖွေ ဒေါင်းလုဒ်လုပ်ခြင်း
        const imagePaths = await searchAndDownloadImages(imageKeywords);
        if (imagePaths.length === 0) throw new Error("No images downloaded from Pexels.");

        // 3. Guided Meditation Script မှ အသံဖိုင်ဖန်တီးခြင်း
        let speechAudioPath = null;
        if (guidedMeditationScript) {
            try {
                console.log("Generating guided meditation audio...");
                const speechUrl = googleTTS.getAudioUrl(guidedMeditationScript, { lang: 'en', slow: true, host: 'https://translate.google.com' });
                const speechFilePath = path.join(__dirname, 'temp', 'speech.mp3');
                const writer = fs.createWriteStream(speechFilePath);
                const response = await axios({ url: speechUrl, responseType: 'stream' });
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
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
        const longVideoData = await uploadVideo(finalLong, thumbPath, youtubeTitle, youtubeDescription, youtubeTags, false);
        const longUrl = `https://youtu.be/${longVideoData.id}`;

        // --- Shorts Video ---
        console.log("--- Starting Shorts Video Process ---");
        const shortsDesc = `Enjoy a short moment of peace with "${youtubeTitle}". #shorts #meditation #relaxingmusic`;
        const shortsTags = ['shorts', 'meditation', 'relaxing music', ...youtubeTags.slice(0, 5)];
        // Shorts အတွက် ပုံတစ်ပုံနှင့် quote ကိုသုံးပါ (စကားပြောမပါ)
        const finalShorts = await renderSlideshow(audioPath, null, [imagePaths[0]], inspirationalQuote, true);
        const shortsVideoData = await uploadVideo(finalShorts, null, youtubeTitle, shortsDesc, shortsTags, true);
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