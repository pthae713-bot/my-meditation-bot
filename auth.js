// auth.js
const fs = require('fs');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
const TOKEN_PATH = 'token.json'; // ဒီဖိုင်လေး အော်တိုထွက်လာပါလိမ့်မယ်

fs.readFile('credentials.json', (err, content) => {
    if (err) return console.log('Error loading client secret file:', err);
    authorize(JSON.parse(content));
});

function authorize(credentials) {
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    fs.readFile(TOKEN_PATH, (err, token) => {
        if (err) return getNewToken(oAuth2Client);
        console.log("Token ရှိပြီးသားပါ။ bot.js ကို Run နိုင်ပါပြီ။");
    });
}

function getNewToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
    console.log('၁။ ဒီ Link ကို Browser မှာ ဖွင့်ပါ:', authUrl);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('၂။ အဲ့ဒီကရလာတဲ့ Code ကို ဒီမှာ လာထည့်ပါ: ', (code) => {
        rl.close();
        oAuth2Client.getToken(code, (err, token) => {
            if (err) return console.error('Error retrieving access token', err);
            fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
                if (err) return console.error(err);
                console.log('✅ Token သိမ်းဆည်းပြီးပါပြီ! အခု bot.js ကို Run လို့ရပါပြီ။');
            });
        });
    });
}