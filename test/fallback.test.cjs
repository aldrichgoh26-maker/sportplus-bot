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

// Set when this file re-enters itself as a child process; see sigtermExitsClean().
const CHILD_MODE = !!process.env.BOT_TEST_CHILD;

let calls = [];
let photoError = null; // set per case, thrown by the sendPhoto stub
// Every caption the bot tried to send, photo path and text path alike. The CTA link
// used to be a literal in the template string with nothing asserting it, which is how
// a dead t.me handle sat in every post for two months without anyone noticing.
let captions = [];

const fakeTelegram = {
    sendPhoto: async (_chat, _photo, opts) => {
        calls.push('sendPhoto');
        captions.push(opts?.caption ?? '');
        throw photoError;
    },
    sendMessage: async (_chat, text) => {
        calls.push('sendMessage');
        captions.push(text ?? '');
        return { message_id: 1 };
    },
};

// Shaped like a telegraf TelegramError, which carries both .code and .response.
function apiError(code, description) {
    const e = new Error(`${code}: ${description}`);
    e.code = code;
    e.response = { ok: false, error_code: code, description };
    return e;
}

// The first launch() rejects with the 409 that used to kill the process; the retry
// then holds the poll open, the way a healthy bot does once the other container
// has gone. Lets us assert both survival and recovery.
let launchCalls = 0;

Module._load = function (request) {
    if (request === 'telegraf') {
        return {
            Telegraf: class {
                constructor() { this.telegram = fakeTelegram; this.polling = undefined; }
                on() {}
                // Faithful to telegraf 4.16.3 (lib/telegraf.js): stop() THROWS unless
                // something is actually running. The SIGTERM case depends on this being
                // modelled rather than stubbed away -- a no-op stop() would have made the
                // bug invisible, which is why it went unnoticed until Render reported it.
                stop() {
                    if (this.polling === undefined) throw new Error('Bot is not running!');
                    this.polling = undefined;
                }
                launch() {
                    // 401 is the one code startBouncer refuses to retry, so the child ends
                    // up alive with polling never started -- exactly the state Render finds
                    // it in when it sends SIGTERM to spin the instance down.
                    if (CHILD_MODE) return Promise.reject(apiError(401, 'Unauthorized'));
                    if (++launchCalls === 1) {
                        return Promise.reject(apiError(409,
                            'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'));
                    }
                    this.polling = {};              // healthy: polls until stopped
                    return new Promise(() => {});
                }
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

// Child mode. Asserting on a SIGTERM exit code needs a real process to signal and a
// real code to read, which an in-process test cannot produce -- so this file re-enters
// itself, giving us bot.js under the same stubs in a process the parent can kill.
if (CHILD_MODE) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sportplus-bot-child-'));
    process.chdir(tmp);                 // posted_links.json is written relative to cwd
    Object.assign(process.env, {
        BOT_TOKEN: 'stub',
        CHANNEL_ID: '-1004299960350',
        THREAD_ID: '286',
        MAX_AGE_HOURS: '7.5',
        PORT: '0',                      // any free port; the parent waits on the log line
    });
    require(BOT);
    return;                             // valid at CJS module top level
}

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

// A clean spin-down must exit 0. Render treats a non-zero exit as a FAILED instance,
// and a failed instance is not the same as a sleeping one: on 2026-08-21 twenty
// consecutive scheduler ticks got an instant 503 with no container ever booting.
// Before the fix this path either threw "Bot is not running!" out of the signal handler
// or hung until it was killed, because app.listen keeps the event loop alive.
async function sigtermExitsClean() {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [__filename], {
        env: { ...process.env, BOT_TEST_CHILD: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out = [];
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));

    const waitFor = (pred, ms) => new Promise((res) => {
        const deadline = Date.now() + ms;
        const tick = setInterval(() => {
            if (pred()) { clearInterval(tick); res(true); }
            else if (Date.now() > deadline) { clearInterval(tick); res(false); }
        }, 50);
    });

    const started = await waitFor(() => out.join('').includes('Server listening'), 15000);
    if (!started) {
        child.kill('SIGKILL');
        return { ok: false, detail: 'child never got as far as listening', log: out.join('') };
    }

    const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
    child.kill('SIGTERM');
    const raced = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15000))]);

    if (raced === null) {
        child.kill('SIGKILL');
        return { ok: false, detail: 'still running 15s after SIGTERM (never exits on its own)', log: out.join('') };
    }
    return {
        ok: raced.code === 0,
        detail: `exit code ${raced.code}${raced.signal ? ` / signal ${raced.signal}` : ''}`,
        log: out.join(''),
    };
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
        // A sentinel, not the real link: this asserts the caption carries whatever
        // DISCUSS_URL is configured to be, so the wiring is what is under test and the
        // production message id is not pinned into the harness.
        DISCUSS_URL: 'https://t.me/EXAMPLE/999',
    });

    require(BOT);
    await new Promise((r) => setTimeout(r, 400)); // let app.listen bind

    let failed = 0;

    // A rejected launch() must not take the HTTP route down with it. If the process
    // had died on that 409 this request would not connect at all -- which is exactly
    // how the scheduler saw 503 on every tick and switched itself off.
    {
        photoError = apiError(400, 'Bad Request: failed to get HTTP URL content');
        const { result } = await quietly(() => runBot(port).catch((e) => ({ status: 'NO CONNECTION: ' + e.code })));
        const ok = result.status === 200;
        if (!ok) failed++;
        console.log(`${ok ? '  PASS' : '  FAIL'}  polling died (409) -> process survives, /run-bot still serves`);
        console.log(`        HTTP ${result.status}`);
        fs.rmSync(path.join(tmp, 'posted_links.json'), { force: true });
    }
    for (const c of CASES) {
        calls = [];
        captions = [];
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

    // The CTA has to ride BOTH paths. The photo caption and the text fallback are built
    // from the same string today, but they are two separate sends, and a reader who only
    // ever gets the fallback is exactly the reader who would be left with no way out of a
    // closed NEWS topic.
    {
        calls = [];
        captions = [];
        photoError = apiError(400, 'Bad Request: failed to get HTTP URL content');
        fs.rmSync(path.join(tmp, 'posted_links.json'), { force: true });
        await quietly(() => runBot(port));
        const carrying = captions.filter((c) => c.includes(process.env.DISCUSS_URL)).length;
        const ok = captions.length === 2 && carrying === 2;
        if (!ok) failed++;
        console.log(`${ok ? '  PASS' : '  FAIL'}  the chat CTA rides both the photo caption and the text fallback`);
        console.log(`        sends=${captions.length}  carrying DISCUSS_URL=${carrying}`);
    }

    // ...and it must come BACK, or the bouncer is silently dead until a redeploy.
    // First backoff is 5s, so wait for it rather than racing it.
    const deadline = Date.now() + 20000;
    while (launchCalls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    const retried = launchCalls >= 2;
    if (!retried) failed++;
    console.log(`${retried ? '  PASS' : '  FAIL'}  polling is retried after the 409 (launch calls: ${launchCalls})`);

    {
        const r = await sigtermExitsClean();
        if (!r.ok) failed++;
        console.log(`${r.ok ? '  PASS' : '  FAIL'}  SIGTERM with polling stopped -> clean exit 0, not a failed instance`);
        console.log(`        ${r.detail}`);
        if (!r.ok) console.log(r.log.split('\n').map((l) => '        | ' + l).join('\n'));
    }

    const total = CASES.length + 4;
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} of ${total} FAILED` : `\nall ${total} passed`);
    process.exit(failed ? 1 : 0);
})();
