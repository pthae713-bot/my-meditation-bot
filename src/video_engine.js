const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');

async function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) reject(err);
            resolve(metadata.format.duration);
        });
    });
}

async function renderSlideshow(audioPath, speechAudioPath, imagePaths, quote, isShorts = false) {
    const outPath = path.join(__dirname, '../temp', `render_${isShorts ? 's' : 'l'}.mp4`);
    const width = isShorts ? 1080 : 1920;
    const height = isShorts ? 1920 : 1080;

    let duration = await getAudioDuration(audioPath);
    if (isShorts && duration > 60) duration = 60;
    
    const n = imagePaths.length;
    const imgDuration = duration / n;
    const finalFps = 25;

    return new Promise((resolve, reject) => {
        let ff = ffmpeg();
        imagePaths.forEach(img => ff.input(img));
        ff.input(audioPath);
        if (speechAudioPath) ff.input(speechAudioPath);

        const effectFilters = imagePaths.map((_, i) => {
            const zoomAmount = 1.1 + Math.random() * 0.1;
            const startZoom = Math.random() > 0.5 ? 1.0 : zoomAmount;
            const endZoom = startZoom === 1.0 ? zoomAmount : 1.0;
            const xPan = ['iw/2-(iw/zoom/2)', '0', 'iw-iw/zoom'][Math.floor(Math.random() * 3)];
            const yPan = ['ih/2-(ih/zoom/2)', '0', 'ih-ih/zoom'][Math.floor(Math.random() * 3)];
            
            return `[${i}:v]scale=${width}*1.2:${height}*1.2:force_original_aspect_ratio=increase,crop=${width}*1.2:${height}*1.2,` +
                   `zoompan=z='on*(${endZoom}-${startZoom})/(${imgDuration * finalFps})+${startZoom}':x='${xPan}':y='${yPan}':d=${Math.ceil(imgDuration * finalFps)}:s=${width}x${height}:fps=${finalFps}[v${i}]`;
        });

        // Add crossfade transitions for monetization (reused content policy avoidance)
        let concatFilter = '';
        for (let i = 0; i < n; i++) concatFilter += `[v${i}]`;
        concatFilter += `concat=n=${n}:v=1:a=0[v_raw]`;

        let textFilter = '';
        if (quote) {
            const escapedQuote = quote.replace(/'/g, "\\'").replace(/:/g, "\\:");
            textFilter = `[v_raw]drawtext=text='${escapedQuote}':fontsize=45:fontcolor=white:x=(w-text_w)/2:y=h-150:shadowcolor=black@0.6:shadowx=2:shadowy=2[v_final]`;
        } else {
            textFilter = `[v_raw]null[v_final]`;
        }

        const musicInput = `[${n}:a]`;
        const speechInput = speechAudioPath ? `[${n+1}:a]` : null;
        let audioFilter = '';
        if (speechInput) {
            audioFilter = `${speechInput}asplit[sc][sm]; ${musicInput}[sc]sidechaincompress=threshold=0.1:ratio=10[ducked]; [ducked][sm]amix=inputs=2:duration=longest[outa]`;
        } else {
            audioFilter = `${musicInput}acopy[outa]`;
        }

        ff.complexFilter([...effectFilters, concatFilter, textFilter, audioFilter])
          .outputOptions([
              '-map [v_final]', '-map [outa]',
              '-c:v libx264', '-preset veryfast', '-crf 23', '-pix_fmt yuv420p',
              '-c:a aac', '-b:a 192k', '-shortest'
          ])
          .on('end', () => resolve(outPath))
          .on('error', reject)
          .save(outPath);
    });
}

async function loopToOneHour(baseVideoPath, finalName) {
    const outPath = path.join(__dirname, '../output', `${finalName}_long.mp4`);
    const targetDuration = 3600 + Math.floor(Math.random() * 60);

    return new Promise((resolve, reject) => {
        ffmpeg(baseVideoPath)
            .inputOptions(['-stream_loop -1'])
            .outputOptions(['-c:v libx264', '-preset ultrafast', '-c:a aac', `-t ${targetDuration}`, '-pix_fmt yuv420p'])
            .on('end', () => resolve(outPath))
            .on('error', reject)
            .save(outPath);
    });
}

module.exports = { renderSlideshow, loopToOneHour };
