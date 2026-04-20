require('dotenv').config();
const { Telegraf } = require('telegraf');
const Parser = require('rss-parser');
const fs = require('fs');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
const parser = new Parser({ customFields: { item: ['enclosure', 'media:content'] } });

const FEED_URL = 'https://www.sportplus.sg/blog-feed.xml'; 
const CHANNEL_ID = process.env.CHANNEL_ID;
const MEMORY_FILE = 'last_article.txt';

function getLastPostedLink() {
    if (fs.existsSync(MEMORY_FILE)) return fs.readFileSync(MEMORY_FILE, 'utf8').trim();
    return '';
}

async function checkFeedAndPost() {
    console.log(`[${new Date().toLocaleTimeString()}] Cron triggered: Checking feed...`);
    try {
        const feed = await parser.parseURL(FEED_URL);
        const newestArticle = feed.items[0];
        const lastPostedLink = getLastPostedLink();

        if (newestArticle.link === lastPostedLink) {
            console.log('No new articles. All good.');
            return false;
        }

        console.log('🚨 NEW ARTICLE! Posting...');
        let summary = newestArticle.contentSnippet || "Click the link to read more.";
        if (summary.length > 200) summary = summary.substring(0, 200) + '...';

        // --- UPDATED CAPTION: BOTH LINKS ARE HERE ---
        const caption = `📰 *${newestArticle.title}*\n\n📝 ${summary}\n\n🔗 [Read Full Article](${newestArticle.link})\n\n📢 *Join* [@SportPlusSGupdates](https://t.me/SportPlusSGupdates) *for more updates!*`;
        
        const imageUrl = newestArticle.enclosure?.url || newestArticle['media:content']?.$?.url;

        if (imageUrl) {
            await bot.telegram.sendPhoto(CHANNEL_ID, imageUrl, { caption: caption, parse_mode: 'Markdown' });
        } else {
            await bot.telegram.sendMessage(CHANNEL_ID, caption, { parse_mode: 'Markdown' });
        }

        fs.writeFileSync(MEMORY_FILE, newestArticle.link);
        console.log('✅ Posted and saved!');
        return true; 
    } catch (error) {
        console.error('Error checking feed:', error);
        return false;
    }
}

bot.launch();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is awake!');
});

app.get('/run-bot', async (req, res) => {
    const posted = await checkFeedAndPost();
    if (posted) {
        res.status(200).send('Checked feed and posted new article.');
    } else {
        res.status(200).send('Checked feed. No new articles.');
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));