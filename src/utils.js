const googleTTS = require('google-tts-api');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

/**
 * Splits long text into chunks of 200 characters and generates TTS for each,
 * then merges them into a single audio file.
 */
async function generateLongTTS(text, outputPath) {
    const chunks = googleTTS.getAllAudioUrls(text, {
        lang: 'en',
        slow: true,
        host: 'https://translate.google.com',
    });

    const tempFiles = [];
    for (let i = 0; i < chunks.length; i++) {
        const tempPath = path.join(path.dirname(outputPath), `temp_speech_${i}.mp3`);
        const writer = fs.createWriteStream(tempPath);
        const response = await axios({ url: chunks[i].url, responseType: 'stream' });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        tempFiles.push(tempPath);
    }

    if (tempFiles.length === 1) {
        await fs.move(tempFiles[0], outputPath, { overwrite: true });
    } else {
        // Merge multiple audio files
        await new Promise((resolve, reject) => {
            let command = ffmpeg();
            tempFiles.forEach(f => command.input(f));
            command
                .on('error', reject)
                .on('end', async () => {
                    for (const f of tempFiles) await fs.remove(f);
                    resolve();
                })
                .mergeToFile(outputPath, path.dirname(outputPath));
        });
    }
}

module.exports = { generateLongTTS };
