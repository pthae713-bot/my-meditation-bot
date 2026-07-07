const { GoogleGenerativeAI } = require("@google/generative-ai");

async function generateAiContent(genAI, songTitle, channelName) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
        const today = new Date();
        const options = { year: 'numeric', month: 'long', day: 'numeric' };
        const formattedDate = today.toLocaleDateString('en-US', options);

        const prompt = `Based on the song title "${songTitle}", generate content for a YouTube meditation video. 
        The goal is to create high-quality, unique, and SEO-optimized metadata for monetization.
        Provide output only in JSON format with keys: youtubeTitle, youtubeDescription, youtubeTags, inspirationalQuote, imageKeywords, guidedMeditationScript.
        Include disclaimer: "Disclosure: This video was created with the assistance of generative AI technologies."
        Include: "📅 Published: ${formattedDate}" and "© ${channelName}" at the end.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        
        let content;
        const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || [null, text];
        try {
            content = JSON.parse(jsonMatch[1]);
        } catch (e) {
            throw new Error("Failed to parse AI JSON");
        }
        
        return content;
    } catch (error) {
        console.error("AI Generation Error:", error);
        return {
            youtubeTitle: songTitle,
            youtubeDescription: `Enjoy this beautiful meditation song: ${songTitle}`,
            youtubeTags: ['meditation', 'relaxing music'],
            inspirationalQuote: "Peace comes from within.",
            imageKeywords: "nature meditation",
            guidedMeditationScript: null
        };
    }
}

module.exports = { generateAiContent };
