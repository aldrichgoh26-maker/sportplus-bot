// Exercises the admin broadcast flow through bot.js's real handler wiring.
//
// telegraf is stubbed at the module loader with a router faithful to the two
// semantics this feature depends on: handlers run in registration order, and a
// handler that does not call next() ends the chain. Fully offline -- nothing is
// sent to Telegram, and every assertion about "did this reach the group" is a
// check on the chat id the stub was called with.
//
//   npm test
//
// What it is really guarding: a preview that posts before the button is tapped,
// a double tap that posts twice, and a bouncer that deletes private messages.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BOT = path.join(__dirname, '..', 'bot.js');
const GROUP = '-1004299960350';
const NEWS_THREAD = 286;
const OWNER = 872399343;      // an admin, per getChatAdministrators
const SECOND_ADMIN = 291654364;
const STRANGER = 555000111;

let sends = [];        // every sendMessage/sendPhoto, with the chat it targeted
let replies = [];      // ctx.reply -- what the admin sees in the DM
let answers = [];      // ctx.answerCbQuery -- the toast on the button
let deletions = [];    // ctx.deleteMessage -- the bouncer
let adminsError = null;
let replyError = null;
let msgId = 1000;

const fakeTelegram = {
    sendMessage: async (chat, text, opts = {}) => {
        sends.push({ kind: 'text', chat: String(chat), text, opts });
        return { message_id: ++msgId };
    },
    sendPhoto: async (chat, photo, opts = {}) => {
        sends.push({ kind: 'photo', chat: String(chat), photo, opts });
        return { message_id: ++msgId };
    },
    getChatAdministrators: async () => {
        if (adminsError) throw adminsError;
        return [{ user: { id: OWNER } }, { user: { id: SECOND_ADMIN } }];
    },
};

// A router, not a mock: registration order and next() are the whole point.
const instances = [];
class StubTelegraf {
    constructor() {
        this.telegram = fakeTelegram;
        this.polling = undefined;
        this.handlers = [];
        instances.push(this);
    }
    on(type, fn) { this.handlers.push({ type, fn }); }
    command(name, fn) { this.handlers.push({ type: 'command', name, fn }); }
    launch() { this.polling = {}; return new Promise(() => {}); }
    stop() { if (!this.polling) throw new Error('Bot is not running!'); this.polling = undefined; }

    matches(h, update) {
        if (h.type === 'callback_query') return !!update.callback_query;
        if (!update.message) return false;
        if (h.type === 'message') return true;
        if (h.type === 'command') {
            const t = update.message.text || '';
            return new RegExp(`^/${h.name}(?:@[A-Za-z0-9_]+)?(?:\\s|$)`).test(t);
        }
        return false;
    }

    async dispatch(update) {
        const chain = this.handlers.filter((h) => this.matches(h, update));
        const ctx = {
            chat: update.message?.chat || update.callback_query?.message?.chat,
            from: update.message?.from || update.callback_query?.from,
            message: update.message,
            callbackQuery: update.callback_query,
            telegram: fakeTelegram,
            reply: async (text) => {
                if (replyError) throw replyError;
                replies.push(text);
                return { message_id: ++msgId };
            },
            answerCbQuery: async (t) => { answers.push(t ?? ''); },
            editMessageReplyMarkup: async () => {},
            deleteMessage: async () => { deletions.push(update.message?.message_id ?? '?'); },
        };
        let i = 0;
        const next = async () => { const h = chain[i++]; if (h) return h.fn(ctx, next); };
        await next();
    }
}

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'telegraf') return { Telegraf: StubTelegraf };
    if (request === 'rss-parser') return class { async parseURL() { return { items: [] }; } };
    if (request === 'dotenv') return { config() {} };
    return origLoad.apply(this, arguments);
};

// bot.js reads its config into module-level consts at import, so an env change
// needs a fresh import -- which is also the only way to test an UNSET THREAD_ID.
function loadBot(env = {}) {
    delete require.cache[require.resolve(BOT)];
    delete require.cache[require.resolve(path.join(__dirname, '..', 'broadcast.js'))];
    Object.assign(process.env, {
        BOT_TOKEN: 'stub',
        CHANNEL_ID: GROUP,
        THREAD_ID: String(NEWS_THREAD),
        MAX_AGE_HOURS: '7.5',
        PORT: '0',
        BROADCAST_TOPICS: 'General:0,News:286',
        BROADCAST_ADMIN_IDS: '',
        ...env,
    });
    require(BOT);
    return instances[instances.length - 1];
}

// --- update builders -------------------------------------------------------

const dm = (from, text, entities) => ({
    message: {
        message_id: ++msgId, text, entities,
        chat: { id: from, type: 'private' },
        from: { id: from },
    },
});
const groupMsg = (from, text, thread) => ({
    message: {
        message_id: ++msgId, text, message_thread_id: thread,
        chat: { id: Number(GROUP), type: 'supergroup' },
        from: { id: from },
    },
});
const tap = (from, data) => ({
    callback_query: {
        id: 'cb' + ++msgId, data, from: { id: from },
        message: { message_id: msgId, chat: { id: from, type: 'private' } },
    },
});

function reset() { sends = []; replies = []; answers = []; deletions = []; adminsError = null; replyError = null; }
const toGroup = () => sends.filter((s) => s.chat === GROUP);
const preview = () => sends.find((s) => s.chat !== GROUP);
// The confirm button carries the draft id, so this is also the proof a draft exists.
const buttonFor = (name) => {
    const rows = preview()?.opts?.reply_markup?.inline_keyboard || [];
    return rows.flat().find((b) => b.text.includes(name))?.callback_data;
};

// --- cases -----------------------------------------------------------------

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
    if (detail) console.log(`        ${detail}`);
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spbot-broadcast-'));
    process.chdir(tmp);                      // posted_links.json is written to cwd

    const bot = loadBot();
    await new Promise((r) => setTimeout(r, 200));   // let app.listen bind

    // 1. A stranger gets an answer, not a draft.
    reset();
    await bot.dispatch(dm(STRANGER, 'post this for me'));
    check('non-admin DM -> nothing drafted, nothing sent',
        toGroup().length === 0 && !preview() && replies.length === 1,
        `group sends=${toGroup().length} previews=${preview() ? 1 : 0} replies=${replies.length}`);

    // 2. The preview must not be a send. This is the invariant the whole design
    //    exists for: an admin typing a message does not publish it.
    reset();
    await bot.dispatch(dm(OWNER, 'Track session moved to 7pm'));
    const p = preview();
    check('admin DM -> preview in the DM only, group untouched',
        toGroup().length === 0 && !!p && String(p.chat) === String(OWNER) && !!buttonFor('General'),
        `group sends=${toGroup().length} preview chat=${p?.chat} buttons=${!!buttonFor('General')}`);

    // 3. The tap is what publishes, into the topic the button named.
    {
        const data = buttonFor('News');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const g = toGroup();
        check('tapping News -> exactly one send, into thread 286',
            g.length === 1 && g[0].opts.message_thread_id === NEWS_THREAD,
            `sends=${g.length} thread=${g[0]?.opts?.message_thread_id}`);

        // 4. Telegram redelivers callbacks; a double tap must not double-post.
        reset();
        await bot.dispatch(tap(OWNER, data));
        check('double tap -> refused, no second post',
            toGroup().length === 0 && answers.some((a) => /already sent/i.test(a)),
            `sends=${toGroup().length} answer="${answers[0] ?? ''}"`);
    }

    // 5. General is the no-thread target: message_thread_id must be absent, not 0.
    reset();
    await bot.dispatch(dm(OWNER, 'Shop drop Friday'));
    {
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const g = toGroup();
        check('tapping General -> posts with no thread id at all',
            g.length === 1 && g[0].opts.message_thread_id === undefined,
            `thread=${JSON.stringify(g[0]?.opts?.message_thread_id)}`);
    }

    // 6. Another admin must not fire a draft they cannot fully see.
    reset();
    await bot.dispatch(dm(OWNER, 'Half-written thought'));
    {
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(SECOND_ADMIN, data));
        check('a different admin tapping someone else\'s draft -> refused',
            toGroup().length === 0 && answers.some((a) => /who wrote this/i.test(a)),
            `sends=${toGroup().length} answer="${answers[0] ?? ''}"`);

        reset();
        await bot.dispatch(tap(OWNER, data.replace(/:\d+$/, ':x')));
        check('cancel -> draft dropped, nothing sent',
            toGroup().length === 0 && answers.some((a) => /cancelled/i.test(a)),
            `sends=${toGroup().length} answer="${answers[0] ?? ''}"`);
    }

    // 7. Formatting the admin applied in their own client rides through untouched,
    //    and /post is stripped without dragging the offsets out of step.
    reset();
    await bot.dispatch(dm(OWNER, '/post Race is Sunday', [
        { type: 'bot_command', offset: 0, length: 5 },
        { type: 'bold', offset: 14, length: 6 },
    ]));
    {
        const shown = preview();
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const g = toGroup()[0];
        const ok = shown?.text === 'Race is Sunday'
            && g?.text === 'Race is Sunday'
            && JSON.stringify(g?.opts?.entities) === JSON.stringify([{ type: 'bold', offset: 8, length: 6 }]);
        check('/post stripped, bold survives with its offset corrected',
            ok, `text="${g?.text}" entities=${JSON.stringify(g?.opts?.entities)}`);
    }

    // 8. If we cannot confirm who is an admin, we do not publish. The cache is
    //    primed by now, so this also proves the failure path beats the cache when
    //    the caller was never in it.
    reset();
    adminsError = Object.assign(new Error('403: Forbidden'), {
        response: { error_code: 403, description: 'Forbidden: bot was kicked' },
    });
    await bot.dispatch(dm(STRANGER, 'let me in'));
    check('admin lookup failing -> fails closed for an unknown user',
        toGroup().length === 0 && !preview(),
        `group sends=${toGroup().length}`);

    // 9. A broadcast that lands but whose receipt DM does not must never be reported
    //    as a failure. Found by driving the real telegraf composer: the receipt used
    //    to sit inside the try that guards the send, so a failed DM produced
    //    "Not sent -- tap again to retry" for a post the group had already seen.
    reset();
    await bot.dispatch(dm(OWNER, 'Receipt will fail'));
    {
        const data = buttonFor('General');
        reset();
        replyError = new Error('403: bot was blocked by the user');
        await bot.dispatch(tap(OWNER, data));
        const landed = toGroup().length === 1;
        const toldSent = answers.some((a) => /sent to/i.test(a)) && !answers.some((a) => /failed/i.test(a));

        replyError = null;
        answers = [];
        await bot.dispatch(tap(OWNER, data));   // the retry the bad advice would have invited
        check('receipt DM fails after a successful post -> still reported sent, not retryable',
            landed && toldSent && toGroup().length === 1 && answers.some((a) => /already sent/i.test(a)),
            `posted=${toGroup().length} toast="${answers[0] ?? ''}"`);
    }

    // 10. The bouncer still bounces -- and only in the closed topic.
    reset();
    await bot.dispatch(groupMsg(STRANGER, 'hello', NEWS_THREAD));
    const deletedInNews = deletions.length === 1;
    reset();
    await bot.dispatch(groupMsg(STRANGER, 'hello', 999));
    const keptElsewhere = deletions.length === 0;
    reset();
    await bot.dispatch(dm(OWNER, 'a private draft'));
    const keptInDm = deletions.length === 0;
    check('bouncer deletes in the closed topic only, never a DM or another topic',
        deletedInNews && keptElsewhere && keptInDm,
        `news=${deletedInNews} otherTopic=${keptElsewhere} dm=${keptInDm}`);

    // 11. The dangerous config. THREAD_ID unset used to make the guard compare
    //     undefined to undefined, which is true for every message the bot can see
    //     -- and an admin bot sees all of them.
    {
        const bot2 = loadBot({ THREAD_ID: '' });
        await new Promise((r) => setTimeout(r, 100));
        reset();
        await bot2.dispatch(dm(OWNER, 'still private'));
        const dmSafe = deletions.length === 0;
        reset();
        await bot2.dispatch(groupMsg(STRANGER, 'hello', undefined));
        check('THREAD_ID unset -> the bouncer deletes nothing at all',
            dmSafe && deletions.length === 0,
            `dm=${dmSafe} group=${deletions.length === 0}`);
    }

    const failed = results.filter((r) => !r.ok).length;
    process.chdir(os.tmpdir());
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
