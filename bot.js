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

// Render's free-tier disk is wiped on every deploy, which takes posted_links.json
// with it. Without a ceiling on how far back we look, the first run after a deploy
// would re-post the entire feed. Only articles published inside this window are
// ever eligible, so the worst case is a couple of recent duplicates, not 20.
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 48);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Wix wraps titles in CDATA but still writes entities inside it, so an ampersand
// reaches us as the literal text "&#38;". Decode before escaping or it renders raw.
function decodeEntities(str) {
    return String(str)
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

// Article titles are outside our control. One stray * or _ used to make Telegram
// reject the whole post with a 400 under legacy Markdown, so we send HTML instead
// and escape everything that came from the feed.
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

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

        // Recent articles we haven't posted yet
        const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
        const articlesToPost = feed.items.filter(item => {
            const published = item.pubDate ? Date.parse(item.pubDate) : NaN;
            const isRecent = Number.isFinite(published) && published >= cutoff;
            const isNotPosted = !postedLinks.includes(item.link);
            return isRecent && isNotPosted;
        });

        // Reverse to post oldest first (keeps chronological order in chat)
        articlesToPost.reverse();

        if (articlesToPost.length === 0) {
            console.log(`No new articles in the last ${MAX_AGE_HOURS}h. All good.`);
            return { posted: 0, failed: 0 };
        }

        console.log(`🚨 Found ${articlesToPost.length} new articles! Initiating batch post...`);

        let posted = 0;
        let failed = 0;

        for (const article of articlesToPost) {
            // Decode before truncating so the 200 limit counts real characters
            // and we can never slice through the middle of an entity.
            let summary = decodeEntities(article.contentSnippet || "Click the link to read more.");
            if (summary.length > 200) summary = summary.substring(0, 200) + '...';
            const title = decodeEntities(article.title);

            const caption = `📰 <b>${escapeHtml(title)}</b>\n\n📝 ${escapeHtml(summary)}\n\n🔗 <a href="${escapeHtml(decodeEntities(article.link))}">Read Full Article</a>\n\n📢 <b>Join the conversation in</b> <a href="https://t.me/ATHLObySportPlus">SportPlus | ATHLO+</a> <b>for more!</b>`;
            const imageUrl = article.enclosure?.url || article['media:content']?.$?.url;

            const postOptions = {
                parse_mode: 'HTML',
                message_thread_id: THREAD_ID ? Number(THREAD_ID) : undefined
            };

            try {
                if (imageUrl) {
                    // Telegram fetches the image itself, so a URL that 404s, redirects to HTML
                    // or blows the size limit fails the whole article -- for a reason that has
                    // nothing to do with the text. Post the text instead of losing the item.
                    try {
                        await bot.telegram.sendPhoto(CHAT_ID, imageUrl, { caption: caption, ...postOptions });
                    } catch (photoErr) {
                        // Only a 400 means Telegram rejected the IMAGE. A timeout or 5xx may
                        // have delivered the photo already, so retrying those would double-post.
                        const code = photoErr?.response?.error_code ?? photoErr?.code;
                        if (code !== 400) throw photoErr;
                        const why = photoErr?.response?.description || photoErr?.message;
                        console.warn(`🖼️ Image rejected (${why}) — posting text only: ${article.title}`);
                        await bot.telegram.sendMessage(CHAT_ID, caption, postOptions);
                    }
                } else {
                    await bot.telegram.sendMessage(CHAT_ID, caption, postOptions);
                }

                savePostedLink(article.link);
                posted++;
                console.log(`✅ Posted to News Topic: ${article.title}`);
                await sleep(3000);

            } catch (err) {
                failed++;
                console.error(`❌ Failed to post ${article.title}:`, err);
            }
        }

        console.log(`🏁 Batch posting complete! posted=${posted} failed=${failed}`);
        return { posted, failed };
    } catch (error) {
        console.error('Error checking feed:', error);
        return { posted: 0, failed: 0, error: error.message };
    }
}

// --- THE BOUNCER: KEEPS THE NEWS TOPIC READ-ONLY ---
bot.on('message', async (ctx) => {
    // If a human sends a message specifically in the News Topic, delete it instantly
    if (ctx.message && ctx.message.message_thread_id == THREAD_ID) {
        try {
            await ctx.deleteMessage();
        } catch (err) {
            console.log('Could not delete message. Check if bot has Delete permission.');
        }
    }
});

bot.launch();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is awake!'));
app.get('/run-bot', async (req, res) => {
    const result = await checkFeedAndPost();
    // This used to answer 200 "posted new articles" even when every send failed,
    // which is how a dead chat id went unnoticed for two months. Fail loudly so
    // the cron service surfaces it.
    const ok = !result.error && result.failed === 0;
    res.status(ok ? 200 : 500).json({ ok, ...result });
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
