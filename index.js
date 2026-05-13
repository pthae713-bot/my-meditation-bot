const { Telegraf } = require('telegraf');
const fs = require('fs');
const axios = require('axios');
const path = require('path');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// သီချင်းသိမ်းမယ့် Folder ဆောက်မယ်
if (!fs.existsSync('./songs')) fs.mkdirSync('./songs');

bot.on('audio', async (ctx) => {
    try {
        const fileId = ctx.message.audio.file_id;
        const fileName = ctx.message.audio.title || `song_${Date.now()}`;
        const link = await ctx.telegram.getFileLink(fileId);
        
        const response = await axios({ url: link.href, responseType: 'stream' });
        const filePath = path.join(__dirname, 'songs', `${fileName}.mp3`);
        
        response.data.pipe(fs.createWriteStream(filePath))
            .on('finish', () => ctx.reply(`သီချင်း "${fileName}" ကို သိမ်းဆည်းပြီးပါပြီ။`))
            .on('error', (e) => ctx.reply('Error: ' + e.message));
            
    } catch (error) {
        ctx.reply('သီချင်းသိမ်းရာမှာ အမှားအယွင်းရှိလို့ ပြန်စစ်ပေးပါ။');
    }
});

bot.launch();