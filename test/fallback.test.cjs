// Exercises the real sendPhoto -> sendMessage fallback in bot.js.
//
// bot.js exports nothing, so checkFeedAndPost() is only reachable through its own
// /run-bot route. This stubs telegraf and rss-parser at the module loader, starts
// the real server on a free port, and drives it over localhost. Fully offline --
// nothing is sent to Telegram and nothing is read from the live feed.
//
//   npm test
//
// Why this test exists: an image Telegram cannot fetch used to fail the whole
// article, so a post was lost for a reason unrelated to its text.

const Module = require('module');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const origLoad = Module._load;
const BOT = path.join(__dirname, '..', 'bot.js');

let calls = [];
let photoError = null; // set per case, thrown by the sendPhoto stub

const fakeTelegram = {
    sendPhoto: async () => { calls.push('sendPhoto'); throw photoError; },
    sendMessage: async () => { calls.push('sendMessage'); return { message_id: 1 }; },
};

// Shaped like a telegraf TelegramError, which carries both .code and .response.
function apiError(code, description) {
    const e = new Error(`${code}: ${description}`);
    e.code = code;
    e.response = { ok: false, error_code: code, description };
    return e;
}

Module._load = function (request) {
    if (request === 'telegraf') {
        return {
            Telegraf: class {
                constructor() { this.telegram = fakeTelegram; }
                on() {} launch() {} stop() {}
            },
        };
    }
    if (request === 'rss-parser') {
        return class {
            async parseURL() {
                return {
                    items: [{
                        title: 'Fallback test article',
                        link: 'https://example.test/article-' + Math.random(),
                        pubDate: new Date().toUTCString(), // always inside MAX_AGE_HOURS
                        contentSnippet: 'snippet',
                        enclosure: { url: 'https://bad.example/broken.jpg' },
                    }],
                };
            }
        };
    }
    if (request === 'dotenv') return { config() {} };
    return origLoad.apply(this, arguments);
};

const freePort = () => new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

const runBot = (port) => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port, path: '/run-bot' }, (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) }));
    }).on('error', rej);
});

// Two of the three cases make bot.js log a failure and dump a stack, which is
// correct behaviour but reads like a broken test run. Buffer its output and only
// replay it for a case that actually fails.
async function quietly(fn) {
    const buffered = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(real)) {
        console[k] = (...a) => buffered.push(a.map(String).join(' '));
    }
    try {
        return { result: await fn(), buffered };
    } finally {
        Object.assign(console, real);
    }
}

const CASES = [
    {
        name: 'image rejected (400) -> falls back to text, article still lands',
        error: apiError(400, 'Bad Request: failed to get HTTP URL content'),
        calls: 'sendPhoto,sendMessage',
        status: 200,
        body: { ok: true, posted: 1, failed: 0 },
    },
    {
        // A 5xx may mean the photo WAS delivered; retrying would double-post.
        name: 'transient 5xx -> does NOT fall back',
        error: apiError(500, 'Internal Server Error'),
        calls: 'sendPhoto',
        status: 500,
        body: { ok: false, posted: 0, failed: 1 },
    },
    {
        name: 'network timeout (no .response) -> does NOT fall back',
        error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        calls: 'sendPhoto',
        status: 500,
        body: { ok: false, posted: 0, failed: 1 },
    },
];

(async () => {
    // posted_links.json is written to cwd -- keep the repo's seeded copy untouched.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sportplus-bot-test-'));
    process.chdir(tmp);

    const port = await freePort();
    Object.assign(process.env, {
        BOT_TOKEN: 'stub',
        CHANNEL_ID: '-1004299960350',
        THREAD_ID: '286',
        MAX_AGE_HOURS: '7.5',
        PORT: String(port),
    });

    require(BOT);
    await new Promise((r) => setTimeout(r, 400)); // let app.listen bind

    let failed = 0;
    for (const c of CASES) {
        calls = [];
        photoError = c.error;
        fs.rmSync(path.join(tmp, 'posted_links.json'), { force: true });

        const { result: res, buffered } = await quietly(() => runBot(port));
        const got = { calls: calls.join(','), status: res.status, ...res.body };
        const ok = got.calls === c.calls
            && got.status === c.status
            && got.ok === c.body.ok
            && got.posted === c.body.posted
            && got.failed === c.body.failed;

        if (!ok) failed++;
        console.log(`${ok ? '  PASS' : '  FAIL'}  ${c.name}`);
        console.log(`        calls=${got.calls}  HTTP ${got.status}  ${JSON.stringify(res.body)}`);
        if (!ok) {
            console.log(`        WANTED calls=${c.calls}  HTTP ${c.status}  ${JSON.stringify(c.body)}`);
            console.log(buffered.map((l) => '        | ' + l).join('\n'));
        }
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} of ${CASES.length} FAILED` : `\nall ${CASES.length} passed`);
    process.exit(failed ? 1 : 0);
})();
