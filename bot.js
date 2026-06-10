require('dotenv').config();
const { Telegraf } = require('telegraf');
const Parser = require('rss-parser');
const fs = require('fs');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
const parser = new Parser({ customFields: { item: ['enclosure', 'media:content'] } });

const FEED_URL = 'https://www.sportplus.sg/blog-feed.xml'; 
const CHAT_ID = process.env.CHANNEL_ID; 
const THREAD_ID = process.env.THREAD_ID; 
const MEMORY_FILE = 'posted_links.json';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getPostedLinks() {
    if (fs.existsSync(MEMORY_FILE)) {
        return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
    return [];
}

function savePostedLink(link) {
    const links = getPostedLinks();
    if (!links.includes(link)) {
        links.push(link);
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(links));
    }
}

async function checkFeedAndPost() {
    console.log(`[${new Date().toLocaleTimeString()}] Cron triggered: Checking feed...`);
    try {
        const feed = await parser.parseURL(FEED_URL);
        const postedLinks = getPostedLinks();

        // Target 2026 articles that haven't been posted yet
        const articlesToPost = feed.items.filter(item => {
            const is2026 = item.pubDate && item.pubDate.includes('2026');
            const isNotPosted = !postedLinks.includes(item.link);
            return is2026 && isNotPosted;
        });

        // Reverse to post oldest first (keeps chronological order in chat)
        articlesToPost.reverse();

        if (articlesToPost.length === 0) {
            console.log('No new 2026 articles found. All good.');
            return false;
        }

        console.log(`🚨 Found ${articlesToPost.length} new articles! Initiating batch post...`);

        for (const article of articlesToPost) {
            let summary = article.contentSnippet || "Click the link to read more.";
            if (summary.length > 200) summary = summary.substring(0, 200) + '...';

            // Custom caption with summary, article link, and HUB join link
            const caption = `📰 *${article.title}*\n\n📝 ${summary}\n\n🔗 [Read Full Article](${article.link})\n\n📢 *Join the conversation in* [SportPlus THE HUB](https://t.me/SportPlusTHEHUB) *for more!*`;
            const imageUrl = article.enclosure?.url || article['media:content']?.$?.url;

            // Target the specific Topic (Thread ID)
            const postOptions = { 
                parse_mode: 'Markdown',
                message_thread_id: THREAD_ID 
            };

            try {
                if (imageUrl) {
                    await bot.telegram.sendPhoto(CHAT_ID, imageUrl, { caption: caption, ...postOptions });
                } else {
                    await bot.telegram.sendMessage(CHAT_ID, caption, postOptions);
                }
                
                savePostedLink(article.link);
                console.log(`✅ Posted to News Topic: ${article.title}`);
                await sleep(3000); // 3-second delay to avoid spam filters

            } catch (err) {
                console.error(`❌ Failed to post ${article.title}:`, err);
            }
        }

        console.log('🏁 Batch posting complete!');
        return true; 
    } catch (error) {
        console.error('Error checking feed:', error);
        return false;
    }
}

bot.launch();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is awake!'));
app.get('/run-bot', async (req, res) => {
    const posted = await checkFeedAndPost();
    if (posted) res.status(200).send('Checked feed and posted new articles.');
    else res.status(200).send('Checked feed. No new articles.');
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
