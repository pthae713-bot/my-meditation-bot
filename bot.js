require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { google } = require('googleapis');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const googleTTS = require('google-tts-api');

const ADMIN_ID = process.env.ADMIN_ID || '2035091217';
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

async function generateAiContent(songTitle) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.0-pro" });
        const prompt = `Based on the song title "${songTitle}", generate content for a YouTube meditation video. Provide the output in JSON format with six keys:
1. "youtubeTitle": An engaging, SEO-friendly title for a 1-hour meditation video.
2. "youtubeDescription": A detailed, SEO-friendly description (around 3-4 paragraphs). Include relevant hashtags at the end. IMPORTANT: Conclude the description with the following disclaimer on a new line: 'Disclosure: This video, including its audio-visual elements and descriptive text, was created with the assistance of generative AI technologies to provide a unique and immersive experience.'
3. "youtubeTags": An array of 15-20 relevant and effective YouTube tags.
4. "inspirationalQuote": A unique and thought-provoking quote related to the song's theme (e.g., peace, dawn, rivers). Avoid generic phrases like 'Breathe in, breathe out'. Max 150 chars.
5. "imageKeywords": A string of 3-4 keywords for Pexels to find background visuals (e.g., "serene forest, calm ocean").
6. "guidedMeditationScript": A short, soothing guided meditation script (2-3 paragraphs, approx. 100-150 words) that aligns with the video's theme. It should be written in a calm, inviting tone, guiding the listener into a state of relaxation.

Example for song title "Whispers of the Dawn":
{
  "youtubeTitle": "Whispers of the Dawn | 1-Hour Morning Meditation Music for Positive Energy",
  "youtubeDescription": "Embrace the new day with 'Whispers of the Dawn,' an hour-long journey of serene and uplifting meditation music...",
  "youtubeTags": ["morning meditation", "positive energy music", ...],
  "inspirationalQuote": "With the new day comes new strength and new thoughts.",
  "imageKeywords": "sunrise, misty forest, gentle stream, dewy leaves",
  "guidedMeditationScript": "Welcome. Find a comfortable position and gently close your eyes. As the music begins, bring your awareness to your breath... each inhale, a wave of calm... each exhale, a release of tension. Imagine the first light of dawn touching your skin, filling you with warmth and positive energy for the day ahead. Just be here, in this moment of peace."
}`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        // Extract JSON from the response
        const jsonString = text.match(/```json\n([\s\S]*?)\n```/)[1];
        const content = JSON.parse(jsonString);
        
        console.log("Gemini AI Content Generated:", content);
        return content;

    } catch (error) {
        console.error("Error generating content with Gemini AI:", error);
        // Fallback to a simple title if AI fails
        return {
            youtubeTitle: songTitle,
            youtubeDescription: `Enjoy this beautiful meditation song: ${songTitle}`,
            youtubeTags: ['meditation', 'relaxing music', songTitle.toLowerCase()],
            inspirationalQuote: "The journey of a thousand miles begins with a single step.",
            imageKeywords: "nature meditation",
            guidedMeditationScript: null
        };
    }
}


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



async function renderSlideshow(audioPath, speechAudioPath, imagePaths, quote, isShorts = false) {
    const outPath = path.join(__dirname, 'temp', `render_${isShorts ? 's' : 'l'}.mp4`);
    const width = isShorts ? 1080 : 1920;
    const height = isShorts ? 1920 : 1080;

    let duration = await getAudioDuration(audioPath);
    if (isShorts && duration > 63) {
        duration = 63; // Shorts ကို စက္ကန့် 60 သတ်မှတ်
    }
    
    const n = imagePaths.length;
    if (n === 0) return Promise.reject(new Error("No images provided for slideshow."));
    const imgDuration = duration / n;

    return new Promise((resolve, reject) => {
        let ff = ffmpeg();

        imagePaths.forEach(img => ff.input(img));
        
        ff.input(audioPath);
        if (speechAudioPath) {
            ff.input(speechAudioPath);
        }

        if (isShorts) {
            ff.inputOptions([`-t ${duration}`]); // audio duration ကိုကန့်သတ်
        }

        const finalFps = 25;

        const effectFilters = imagePaths.map((_, i) => {
            const isZoomIn = Math.random() < 0.5;
            // ✅ Fix: Randomize zoom level for more variety to comply with YouTube policies
            const zoomAmount = 1.1 + Math.random() * 0.15; // Random zoom between 1.10 and 1.25
            const startZoom = isZoomIn ? 1.0 : zoomAmount;
            const endZoom = isZoomIn ? zoomAmount : 1.0;
            const xPan = ['iw/2-(iw/zoom/2)', '0', 'iw-iw/zoom'][Math.floor(Math.random() * 3)];
            const yPan = ['ih/2-(ih/zoom/2)', '0', 'ih-ih/zoom'][Math.floor(Math.random() * 3)];
            // Increase pre-scale to avoid black borders with higher zoom
            const preScale = 1.3;
            
            return `[${i}:v]scale=w=${width}*${preScale}:h=${height}*${preScale}:force_original_aspect_ratio=increase,` +
                   `crop=w=${width}*${preScale}:h=${height}*${preScale},` +
                   `zoompan=z='on*(${endZoom}-${startZoom})/(${imgDuration * finalFps})+${startZoom}':` +
                   `x='${xPan}':y='${yPan}':d=${Math.ceil(imgDuration * finalFps)}:` +
                   `s=${width}x${height}:fps=${finalFps},setsar=1[v${i}]`;
        });
        
        const concatInput = imagePaths.map((_, i) => `[v${i}]`).join('');
        const concatFilter = `${concatInput}concat=n=${n}:v=1:a=0[v_no_text]`;
        
        let textFilter = '';
        if (quote) {
            // --- Randomize Text Style for Variety ---
            const fonts = ['Arial', 'Verdana', 'Georgia', 'Times New Roman'];
            const selectedFont = fonts[Math.floor(Math.random() * fonts.length)];
            const fontPath = process.platform === 'win32'
                ? `C\\\\:/Windows/Fonts/${selectedFont}.ttf`
                : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'; // Fallback for non-windows

            const fontSize = Math.floor(Math.random() * 16) + 40; // Random size between 40 and 55
            
            // Randomize vertical position: 15% from top, middle, or 15% from bottom
            const yPositions = [`(h*0.15)`, `(h/2-text_h/2)`, `(h-text_h-h*0.15)`];
            const yPos = yPositions[Math.floor(Math.random() * yPositions.length)];

            const escapedQuote = quote.replace(/'/g, `\\\\\\'`).replace(/:/g, `\\\\:`);

            // Use a shadow instead of a box for a cleaner, more modern look
            textFilter = `[v_no_text]drawtext=fontfile='${fontPath}':text='${escapedQuote}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${yPos}:shadowcolor=black@0.6:shadowx=2:shadowy=2[v_with_text]`;
        }

        const allImageFilters = [...effectFilters, concatFilter];
        if (textFilter) allImageFilters.push(textFilter);

        const finalVideoMap = textFilter ? '[v_with_text]' : '[v_no_text]';

        let filterComplex;
        let outputMaps;
        
        // --- Audio Processing ---
        const musicInput = `[${n}:a]`;
        const speechInput = speechAudioPath ? `[${n+1}:a]` : null;

        if (!isShorts) {
            let audioChain;
            if (speechInput) {
                // With speech: split the speech stream. Use one copy for sidechain control and the other for the final mix.
                // This prevents the "stream consumed" error in FFmpeg.
                audioChain = `${speechInput}asplit[sc][sm]; ${musicInput}[sc]sidechaincompress=threshold=0.1:ratio=10[ducked_music]; [ducked_music][sm]amix=inputs=2:duration=longest[mixed_audio]`;
            } else {
                // Without speech: just use the music
                audioChain = `${musicInput}acopy[mixed_audio]`;
            }
            
            // Apply fade in/out to the final mixed audio
            const fadeDuration = 1.5;
            const fadeStartTime = duration > fadeDuration ? duration - fadeDuration : 0;
            const audioFilter = `${audioChain}; [mixed_audio]afade=t=in:st=0:d=${fadeDuration},afade=t=out:st=${fadeStartTime}:d=${fadeDuration}[outa]`;
            
            filterComplex = [...allImageFilters, audioFilter].join(';');
            outputMaps = [`-map ${finalVideoMap}`, '-map [outa]'];
        
        } else { // For Shorts
            filterComplex = allImageFilters.join(';');
            outputMaps = [`-map ${finalVideoMap}`, `-map ${musicInput}`];
        }

        ff.complexFilter(filterComplex)
          .outputOptions([
              ...outputMaps,
              '-c:v libx264',
              '-preset veryfast',
              '-crf 23',
              '-pix_fmt yuv420p',
              '-c:a aac',
              '-b:a 192k',
              '-shortest'
          ])
          .on('start', cmd => console.log('FFmpeg Render Start with AI Content'))
          .on('end', () => resolve(outPath))
          .on('error', (err, stdout, stderr) => {
              console.error('Cannot process video: ' + err.message);
              console.error('ffmpeg stderr:\n' + stderr);
              reject(new Error('FFmpeg failed during render. Check logs.'));
          })
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
            .on('error', (err, stdout, stderr) => {
                console.error('Cannot loop video: ' + err.message);
                console.error('ffmpeg stderr:\n' + stderr);
                reject(new Error('FFmpeg failed during loop. Check logs.'));
            })
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
        try {
            await youtube.thumbnails.set({
                videoId: res.data.id,
                media: { body: fs.createReadStream(thumbPath) }
            });
        } catch (thumbError) {
            console.warn(`⚠️  Thumbnail upload failed for video ID ${res.data.id}: ${thumbError.message}`);
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