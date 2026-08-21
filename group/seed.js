#!/usr/bin/env node
'use strict';

// Reposts the pinned welcome and the topic starter posts from the files beside this
// one. Written after an admin deleted every message in the group on 2026-08-21 and
// the text turned out to exist nowhere but Telegram itself.
//
//   BOT_TOKEN=... node group/seed.js             dry run -- prints, sends nothing
//   BOT_TOKEN=... node group/seed.js --confirm   posts and pins
//
// Dry by default on purpose: the only thing worse than an empty group is two of
// every welcome message, and this is the kind of script someone runs while trying to
// remember what it does.

const fs = require('fs');
const path = require('path');
const https = require('https');

const CHAT = process.env.CHANNEL_ID || '-1004299960350';
const TOKEN = process.env.BOT_TOKEN;
const CONFIRM = process.argv.includes('--confirm');

// General is addressed by OMITTING message_thread_id -- id 1 is refused outright.
const POSTS = [
    { file: 'welcome.html', thread: null, label: 'welcome (General, pinned)', pin: true },
    { file: 'topic-180-train-and-race.html', thread: 180, label: 'starter: Train & Race' },
    { file: 'topic-173-gear-and-marketplace.html', thread: 173, label: 'starter: Gear & Marketplace' },
];

function api(method, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TOKEN}/${method}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (d) => (data += d));
            // Telegram answers 4xx with a JSON body, so parse before judging status.
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.end(body);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    if (!TOKEN) {
        console.error('BOT_TOKEN is not set.');
        process.exit(1);
    }
    if (!CONFIRM) {
        console.log('DRY RUN -- nothing will be sent. Re-run with --confirm to post.\n');
    }

    let welcomeId = null;
    for (const post of POSTS) {
        const text = fs.readFileSync(path.join(__dirname, post.file), 'utf8').trimEnd();
        console.log(`--- ${post.label}  (thread ${post.thread ?? 'General'}, ${text.length} chars)`);

        if (!CONFIRM) {
            console.log(text.split('\n').map((l) => '    ' + l).join('\n') + '\n');
            continue;
        }

        const payload = { chat_id: CHAT, text, parse_mode: 'HTML', disable_notification: true };
        if (post.thread) payload.message_thread_id = post.thread;
        const r = await api('sendMessage', payload);
        if (!r.ok) {
            console.error(`    FAILED: ${r.description}`);
            process.exit(1);
        }
        console.log(`    posted as message ${r.result.message_id}`);
        if (post.pin) welcomeId = r.result.message_id;
        await sleep(2000);
    }

    if (!CONFIRM) return;

    const pin = await api('pinChatMessage', { chat_id: CHAT, message_id: welcomeId, disable_notification: true });
    console.log(`\npin ${welcomeId}: ${pin.ok ? 'ok' : pin.description}`);
    // The whole point of capturing this: a stale DISCUSS_URL is invisible until
    // someone clicks a news post's CTA and lands on the group page instead.
    console.log(`\nSet this on Render, then redeploy:\n  DISCUSS_URL=https://t.me/ATHLObySportPlus/${welcomeId}`);
})();
