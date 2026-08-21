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

// Where the "chat about this" link lands. The NEWS topic is CLOSED, so a reader
// cannot reply where they are standing -- this link is their only way to a topic
// that accepts posts, and pointing it at the group root just dropped them on the
// topic list they came from.
//
// It has to be a MESSAGE link. The discussion topic is General, and General has no
// topic deep link: t.me/<group>/1 is not a topic address, it silently falls back to
// the group page. A link to a message INSIDE General is the only way in, so this
// points at the pinned welcome. If that message is ever deleted the URL degrades to
// the group page -- exactly the behaviour it replaced -- so a stale id here can
// never be worse than the bare group link, only less useful.
const DISCUSS_URL = process.env.DISCUSS_URL || 'https://t.me/ATHLObySportPlus/316';

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

            const caption = `📰 <b>${escapeHtml(title)}</b>\n\n📝 ${escapeHtml(summary)}\n\n🔗 <a href="${escapeHtml(decodeEntities(article.link))}">Read Full Article</a>\n\n💬 <b>Chat about this in</b> <a href="${DISCUSS_URL}">SportPlus | ATHLO+</a>`;
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

// Long polling exists ONLY for the bouncer above. It must never take the process
// down with it: /run-bot is what the scheduler calls, and an instance that dies
// here answers 503 to every tick until it restarts. An unhandled rejection from
// launch() did exactly that -- 26 consecutive 503s over two hours got the whole
// schedule disabled, and the feed went quiet for a week.
//
// telegraf retries 429s and 5xx inside the polling loop; only 401 and 409 escape.
// A 409 means another container currently holds getUpdates, which is normal for a
// few seconds either side of a deploy, so it is worth waiting out. A 401 is a bad
// token and will never fix itself, so stop rather than spam. Each launch() builds
// a fresh Polling instance, so retrying is safe.
const POLL_BACKOFF_MS = [5000, 15000, 45000, 120000];

async function startBouncer(attempt = 0) {
    const startedAt = Date.now();
    try {
        await bot.launch();   // resolves only once polling stops
        console.log('Long polling ended.');
        return;
    } catch (err) {
        const code = err?.response?.error_code ?? err?.code;
        const why = err?.response?.description || err?.message;

        if (code === 401) {
            console.error(`⚠️ Polling stopped: ${why} — check BOT_TOKEN. Posting is unaffected.`);
            return;
        }
        // A long healthy run earns a fresh retry budget, so unrelated failures
        // months apart don't accumulate into a permanent give-up.
        const next = Date.now() - startedAt > 60000 ? 0 : attempt;
        const wait = POLL_BACKOFF_MS[next];
        if (wait === undefined) {
            console.error(`⚠️ Polling gave up after ${POLL_BACKOFF_MS.length} attempts: ${why}. The bouncer is off; posting is unaffected.`);
            return;
        }
        console.warn(`⚠️ Polling failed (${why}) — retrying in ${wait / 1000}s. Posting is unaffected.`);
        await sleep(wait);
        return startBouncer(next + 1);
    }
}

// Last line of defence for the same invariant. Nothing in this process is worth more
// than the HTTP route the scheduler depends on: a dead process answers 503 to every
// tick, and enough consecutive 503s get the schedule switched off for good. Swallowing
// these is normally bad practice -- it can hide a genuinely broken state -- but the
// alternative here has already cost a week of silence twice, so log loudly and stay up.
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught exception — staying up so /run-bot keeps answering:', err);
});
process.on('unhandledRejection', (err) => {
    console.error('⚠️ Unhandled rejection — staying up so /run-bot keeps answering:', err);
});

startBouncer();

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

const server = app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// Render sends SIGTERM to spin the free instance down every night, and how this
// process answers decides whether it can be woken again in the morning.
//
// Two ways the old two-liner got that wrong. telegraf's stop() THROWS
// "Bot is not running!" when polling never started or has already given up
// (lib/telegraf.js: polling === undefined && webhookServer === undefined), and an
// uncaught throw inside a signal handler exits non-zero. Even without the throw,
// app.listen keeps the event loop alive, so the process never exits on its own and
// waits to be killed. Either way Render records "Instance failed ... Exited with
// status 1" instead of a clean spin-down.
//
// That matters because a service parked as FAILED is not the same as one parked as
// asleep: on 2026-08-21 twenty consecutive scheduler ticks got an instant 503 with no
// container ever booting, for 95 minutes, until a manual request forced a fresh boot.
// A clean shutdown is exit code 0, whatever the bouncer happens to be doing.
function shutdown(signal) {
    try {
        bot.stop(signal);
    } catch (err) {
        // Expected whenever the bouncer gave up or never started. Not a fault.
        console.log(`Polling was not running at ${signal}: ${err.message}`);
    }
    server.close(() => process.exit(0));
    // A held-open connection must not drag the shutdown past Render's grace period
    // and turn a clean exit into a kill. unref so it never delays an early close.
    setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
