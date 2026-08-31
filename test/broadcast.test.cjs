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
let edits = [];        // ctx.editMessageText -- redrawing a poll preview after a toggle
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
    sendVideo: async (chat, file, opts = {}) => {
        sends.push({ kind: 'video', chat: String(chat), file, opts });
        return { message_id: ++msgId };
    },
    // Positional, exactly like telegraf's: (chat, question, options, extra). The
    // stub keeps `options` raw so a test can assert it is InputPollOption objects
    // and not the string[] telegraf's stale typings still promise.
    sendPoll: async (chat, question, options, opts = {}) => {
        sends.push({ kind: 'poll', chat: String(chat), question, options, opts });
        return { message_id: ++msgId };
    },
    sendAnimation: async (chat, file, opts = {}) => {
        sends.push({ kind: 'animation', chat: String(chat), file, opts });
        return { message_id: ++msgId };
    },
    sendDocument: async (chat, file, opts = {}) => {
        sends.push({ kind: 'document', chat: String(chat), file, opts });
        return { message_id: ++msgId };
    },
    // The real one answers an ARRAY, one message per item. The message link depends
    // on that, so the stub has to model it rather than return a bare object.
    sendMediaGroup: async (chat, media, opts = {}) => {
        sends.push({ kind: 'album', chat: String(chat), media, opts });
        return media.map(() => ({ message_id: ++msgId }));
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
            editMessageText: async (text, extra) => { edits.push({ text, extra }); },
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
        BROADCAST_ALBUM_SETTLE_MS: '40',   // real value is 1500; no reason to sleep it
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
// `fields` is the raw Telegram payload shape, e.g. { video: { file_id } } or, for a
// GIF, BOTH { animation, document } -- which is exactly how Telegram sends one.
const dmMedia = (from, fields, caption, entities, groupId) => ({
    message: {
        message_id: ++msgId, caption, caption_entities: entities,
        media_group_id: groupId,
        chat: { id: from, type: 'private' },
        from: { id: from },
        ...fields,
    },
});
const photoField = (n) => ({ photo: [{ file_id: `${n}-small` }, { file_id: `${n}-big` }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tap = (from, data) => ({
    callback_query: {
        id: 'cb' + ++msgId, data, from: { id: from },
        message: { message_id: msgId, chat: { id: from, type: 'private' } },
    },
});

function reset() { sends = []; replies = []; answers = []; deletions = []; edits = []; adminsError = null; replyError = null; }
const toGroup = () => sends.filter((s) => s.chat === GROUP);
const toDm = () => sends.filter((s) => s.chat !== GROUP);
const preview = () => toDm()[0];
// The confirm button carries the draft id, so this is also the proof a draft exists.
// It is searched across every DM send because an album's buttons CANNOT ride on the
// media group -- sendMediaGroup takes no reply_markup -- so they arrive on a second
// message underneath it.
const buttonFor = (name) => {
    for (const s of toDm()) {
        const rows = s?.opts?.reply_markup?.inline_keyboard || [];
        const hit = rows.flat().find((b) => b.text.includes(name));
        if (hit) return hit.callback_data;
    }
    return undefined;
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

    // 9. A video rides the same preview/confirm path, caption and all.
    reset();
    await bot.dispatch(dmMedia(OWNER, { video: { file_id: 'vid-1' } }, 'Race recap', [
        { type: 'bold', offset: 0, length: 4 },
    ]));
    {
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const g = toGroup()[0];
        check('video -> sendVideo with caption and entities intact',
            toGroup().length === 1 && g?.kind === 'video' && g?.file === 'vid-1'
            && g?.opts.caption === 'Race recap'
            && JSON.stringify(g?.opts.caption_entities) === JSON.stringify([{ type: 'bold', offset: 0, length: 4 }]),
            `kind=${g?.kind} file=${g?.file} caption=${JSON.stringify(g?.opts?.caption)}`);
    }

    // 10. THE TRAP: Telegram sends a GIF with BOTH `animation` and `document` set.
    //     Check document first and every GIF silently broadcasts as a file attachment.
    reset();
    await bot.dispatch(dmMedia(OWNER, {
        animation: { file_id: 'gif-1' },
        document: { file_id: 'gif-1-as-doc' },
    }, 'nice'));
    {
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const g = toGroup()[0];
        check('GIF -> sendAnimation, NOT sendDocument',
            toGroup().length === 1 && g?.kind === 'animation' && g?.file === 'gif-1',
            `kind=${g?.kind} file=${g?.file}`);
    }

    // 11. An album is N updates sharing a media_group_id. It must collapse to ONE
    //     draft and ONE post -- three taps and three posts would be the bug.
    reset();
    await bot.dispatch(dmMedia(OWNER, photoField('a'), 'Meet recap', [{ type: 'bold', offset: 0, length: 4 }], 'grp-1'));
    await bot.dispatch(dmMedia(OWNER, photoField('b'), undefined, undefined, 'grp-1'));
    await bot.dispatch(dmMedia(OWNER, { video: { file_id: 'c-vid' } }, undefined, undefined, 'grp-1'));
    await sleep(150);
    {
        const previews = toDm().filter((s) => s.kind === 'album');
        const oneDraft = previews.length === 1 && previews[0].media.length === 3;
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const g = toGroup();
        const payload = g[0]?.media || [];
        const captionOnFirstOnly = payload[0]?.caption === 'Meet recap'
            && payload.slice(1).every((m) => m.caption === undefined);
        check('album of 3 -> one draft, one sendMediaGroup, caption on item 0 only',
            oneDraft && g.length === 1 && g[0].kind === 'album' && payload.length === 3
            && captionOnFirstOnly && payload[2].type === 'video',
            `previews=${previews.length} groupSends=${g.length} items=${payload.length} types=${payload.map((m) => m.type).join(',')}`);
    }

    // 12. Updates are not guaranteed ordered, and the order here is the order the
    //     group sees, so it is sorted rather than trusted.
    reset();
    {
        const first = dmMedia(OWNER, photoField('x'), 'first', undefined, 'grp-2');
        const second = dmMedia(OWNER, photoField('y'), undefined, undefined, 'grp-2');
        await bot.dispatch(second);            // arrives out of order
        await bot.dispatch(first);
        await sleep(150);
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const payload = toGroup()[0]?.media || [];
        check('album items are sorted by message_id, not arrival order',
            payload.length === 2 && payload[0].media === 'x-big' && payload[1].media === 'y-big',
            `order=${payload.map((m) => m.media).join(',')}`);
    }

    // 13. sendMediaGroup rejects animations and refuses to mix documents with photos.
    //     Catching it here beats a 400 at confirm time, after the admin has been shown
    //     a preview and told it was ready.
    reset();
    await bot.dispatch(dmMedia(OWNER, photoField('p'), 'x', undefined, 'grp-3'));
    await bot.dispatch(dmMedia(OWNER, { animation: { file_id: 'g' }, document: { file_id: 'gd' } }, undefined, undefined, 'grp-3'));
    await sleep(150);
    const gifAlbumRefused = toGroup().length === 0 && !buttonFor('General')
        && replies.concat(toDm().map((s) => s.text || '')).some((t) => /GIFs cannot go in an album/i.test(t || ''));

    reset();
    await bot.dispatch(dmMedia(OWNER, photoField('q'), 'x', undefined, 'grp-4'));
    await bot.dispatch(dmMedia(OWNER, { document: { file_id: 'file-1' } }, undefined, undefined, 'grp-4'));
    await sleep(150);
    const mixedRefused = toGroup().length === 0 && !buttonFor('General')
        && toDm().some((s) => /cannot be mixed/i.test(s.text || ''));

    check('albums Telegram would reject are refused up front, with the reason',
        gifAlbumRefused && mixedRefused,
        `gifInAlbum=${gifAlbumRefused} docMixedWithPhoto=${mixedRefused}`);

    // 14. A round video reads as "a video" to whoever sent it, but Telegram gives it
    //     no caption field at all, so it needs its own explanation rather than silence.
    reset();
    await bot.dispatch(dmMedia(OWNER, { video_note: { file_id: 'round-1' } }));
    check('round video -> explained, not silently dropped',
        toGroup().length === 0 && !preview() && replies.some((r) => /Round videos carry no caption/i.test(r)),
        `sends=${toGroup().length} reply="${replies[0] ?? ''}"`);

    // 15. A broadcast that lands but whose receipt DM does not must never be reported
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

    // --- polls ---------------------------------------------------------------
    //
    // A poll is the one draft the admin cannot hand us ready-made: Telegram's clients
    // have no poll composer in a DM, so it is typed as text and the preview is our own
    // rendering. Everything below is therefore guarding two things the message path
    // never had to -- that the text became the poll the admin meant, and that a shape
    // Telegram would refuse is caught here rather than at confirm time.

    // 16. Same first invariant as a broadcast: typing is not publishing.
    reset();
    await bot.dispatch(dm(OWNER, '/poll Which race next?\nStandard Chartered\nSundown', [
        { type: 'bot_command', offset: 0, length: 5 },
    ]));
    {
        const p = preview();
        const rendered = p?.text || '';
        check('/poll -> preview in the DM only, no poll created yet',
            toGroup().length === 0 && sends.every((s) => s.kind !== 'poll')
            && /Which race next\?/.test(rendered)
            && /1\. Standard Chartered/.test(rendered) && /2\. Sundown/.test(rendered)
            && /Anonymous · one answer/.test(rendered) && !!buttonFor('General'),
            `groupSends=${toGroup().length} polls=${sends.filter((s) => s.kind === 'poll').length} preview=${JSON.stringify(rendered)}`);
    }

    // 17. The tap is what creates it. Options must be InputPollOption objects: the
    //     Bot API changed that in 7.3 and telegraf 4.16.3's typings still say string[],
    //     so nothing but this assertion stands between us and the deprecated shape.
    {
        const data = buttonFor('News');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const g = toGroup();
        const poll = g[0];
        check('tapping News -> one sendPoll into thread 286, defaults anonymous + single',
            g.length === 1 && poll?.kind === 'poll'
            && poll.question === 'Which race next?'
            && JSON.stringify(poll.options) === JSON.stringify([{ text: 'Standard Chartered' }, { text: 'Sundown' }])
            && poll.opts.is_anonymous === true && poll.opts.allows_multiple_answers === false
            && poll.opts.message_thread_id === NEWS_THREAD,
            `sends=${g.length} kind=${poll?.kind} options=${JSON.stringify(poll?.options)} opts=${JSON.stringify(poll?.opts)}`);

        // 18. A poll cannot be un-posted and its votes cannot be recovered, so the
        //     double-tap guard matters more here than for a message.
        reset();
        await bot.dispatch(tap(OWNER, data));
        check('double tap on a poll -> refused, no second poll',
            toGroup().length === 0 && answers.some((a) => /already sent/i.test(a)),
            `sends=${toGroup().length} answer="${answers[0] ?? ''}"`);
    }

    // 19. Both toggles, then send. is_anonymous and allows_multiple_answers are fixed
    //     at creation -- no API call changes them afterwards -- so the preview is the
    //     only place they can be set, and the redraw has to keep up with the state.
    reset();
    await bot.dispatch(dm(OWNER, '/poll Training this week?\nTrack\nLong run\nRest', [
        { type: 'bot_command', offset: 0, length: 5 },
    ]));
    {
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data.replace(/:\d+$/, ':a')));
        await bot.dispatch(tap(OWNER, data.replace(/:\d+$/, ':m')));
        const redrawn = edits[edits.length - 1]?.text || '';
        const keys = (edits[edits.length - 1]?.extra?.reply_markup?.inline_keyboard || []).flat().map((b) => b.text);
        const toggled = edits.length === 2
            && /Names shown · multiple answers/.test(redrawn)
            && keys.some((t) => /Names shown/.test(t)) && keys.some((t) => /Multiple answers/.test(t));

        await bot.dispatch(tap(OWNER, data));
        const poll = toGroup()[0];
        check('toggles flip the poll and redraw the preview in step',
            toggled && toGroup().length === 1
            && poll.opts.is_anonymous === false && poll.opts.allows_multiple_answers === true,
            `edits=${edits.length} redrawn=${JSON.stringify(redrawn)} opts=${JSON.stringify(poll?.opts)}`);

        // 20. Once it is out there, its shape is history -- a toggle must not read as
        //     if it changed the poll people are already voting in.
        reset();
        await bot.dispatch(tap(OWNER, data.replace(/:\d+$/, ':a')));
        check('toggling an already-sent poll -> refused, nothing redrawn',
            edits.length === 0 && toGroup().length === 0 && answers.some((a) => /already sent/i.test(a)),
            `edits=${edits.length} answer="${answers[0] ?? ''}"`);
    }

    // 21. Enter SENDS on Telegram Desktop, so one-option-per-line costs a shift-enter
    //     each. The single-line pipe form is the same poll without that hazard.
    reset();
    await bot.dispatch(dm(OWNER, '/poll Shoe day? | Yes | No | Maybe', [
        { type: 'bot_command', offset: 0, length: 5 },
    ]));
    {
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const poll = toGroup()[0];
        check('single line split on "|" -> same question and options',
            poll?.question === 'Shoe day?'
            && JSON.stringify(poll?.options) === JSON.stringify([{ text: 'Yes' }, { text: 'No' }, { text: 'Maybe' }]),
            `question=${JSON.stringify(poll?.question)} options=${JSON.stringify(poll?.options)}`);
    }

    // 22. Someone writing a list writes it as a list, and Telegram numbers the
    //     options itself -- "1. 1. Track" is what not stripping looks like.
    reset();
    await bot.dispatch(dm(OWNER, '/poll Pick one\n1. Track\n- Road\n• Trail', [
        { type: 'bot_command', offset: 0, length: 5 },
    ]));
    {
        const data = buttonFor('General');
        reset();
        await bot.dispatch(tap(OWNER, data));
        const poll = toGroup()[0];
        check('list markers stripped from options, question left alone',
            JSON.stringify(poll?.options) === JSON.stringify([{ text: 'Track' }, { text: 'Road' }, { text: 'Trail' }]),
            `options=${JSON.stringify(poll?.options)}`);
    }

    // 23. Every shape Telegram would refuse, refused here instead -- with the number,
    //     because "too long" without a count tells the admin nothing about the cut.
    {
        const cases = [
            ['no options at all', '/poll Just a question', /at least two options/i],
            ['one option', '/poll Question\nOnly this', /at least two options/i],
            ['13 options', '/poll Q\n' + Array.from({ length: 13 }, (_, i) => `opt ${i}`).join('\n'), /13 options.*caps a poll at 12/i],
            ['301-character question', '/poll ' + 'q'.repeat(301) + '\nA\nB', /301 characters.*caps it at 300/i],
            ['101-character option', '/poll Q\nA\n' + 'b'.repeat(101), /Option 2 is 101 characters/i],
        ];
        let allRefused = true;
        const detail = [];
        for (const [name, text, expect] of cases) {
            reset();
            await bot.dispatch(dm(OWNER, text, [{ type: 'bot_command', offset: 0, length: 5 }]));
            const ok = toGroup().length === 0 && !preview() && replies.some((r) => expect.test(r));
            if (!ok) allRefused = false;
            detail.push(`${name}=${ok}`);
        }
        check('polls Telegram would reject are refused up front, with the number',
            allRefused, detail.join(' '));
    }

    // 24. Telegram counts characters; JS counts UTF-16 code units. Measuring with
    //     .length would refuse a 200-emoji question as if it were 400.
    reset();
    await bot.dispatch(dm(OWNER, '/poll ' + '🏃'.repeat(200) + '\nA\nB', [
        { type: 'bot_command', offset: 0, length: 5 },
    ]));
    check('an emoji question under the limit is measured in characters, not code units',
        !!preview() && replies.length === 0,
        `preview=${!!preview()} replies=${JSON.stringify(replies)}`);

    // 25. Drafting in the group would show the half-written version to the people it
    //     is for. Answering anyway matters because on this host silence is genuinely
    //     ambiguous -- but only admins get the nudge, or it becomes a way to make the
    //     bot talk in a topic.
    reset();
    await bot.dispatch(groupMsg(OWNER, '/poll Question\nA\nB', 999));
    const adminNudged = toGroup().length === 0 && replies.some((r) => /in a DM/i.test(r));
    reset();
    await bot.dispatch(groupMsg(STRANGER, '/poll Question\nA\nB', 999));
    const strangerIgnored = toGroup().length === 0 && replies.length === 0;
    check('/poll in the group -> admin is redirected to the DM, a member gets silence',
        adminNudged && strangerIgnored,
        `admin=${adminNudged} stranger=${strangerIgnored}`);

    // 26. Same gate as everything else: a stranger cannot start one.
    reset();
    await bot.dispatch(dm(STRANGER, '/poll Question\nA\nB', [{ type: 'bot_command', offset: 0, length: 5 }]));
    check('non-admin /poll -> nothing drafted, nothing created',
        toGroup().length === 0 && !preview() && replies.length === 1,
        `groupSends=${toGroup().length} previews=${preview() ? 1 : 0} replies=${replies.length}`);

    // --- the reconnaissance gap ------------------------------------------------
    //
    // Until 2026-08-31 the admin gate was on the handlers that PUBLISH and absent from
    // the handlers that INFORM. /here answered anyone, in any chat, with the chat id
    // and the topic id. /help handed a stranger the whole capability list. /cancel
    // confirmed a draft system existed. None of them post anything, which is exactly
    // why nobody noticed. These four cases fail against the old code.

    // 27. /here was the worst of them: real ids, to anyone who asked.
    reset();
    await bot.dispatch(dm(STRANGER, '/here'));
    const hereLeaksNothing = toGroup().length === 0
        && replies.length === 1
        && !/chat id/i.test(replies[0])
        && !new RegExp(GROUP).test(replies[0]);

    reset();
    await bot.dispatch(dm(OWNER, '/here'));
    const hereStillWorksForAdmins = replies.some((r) => /chat id/i.test(r));

    check('/here gives a stranger no ids, and still answers an admin',
        hereLeaksNothing && hereStillWorksForAdmins,
        `strangerBlocked=${hereLeaksNothing} adminWorks=${hereStillWorksForAdmins}`);

    // 28. In the GROUP a non-admin gets nothing at all. A neutral line is right in a
    //     DM, where silence reads as "the bot is down"; in a topic it would let any
    //     member make the bot speak by typing a command at it.
    reset();
    await bot.dispatch(groupMsg(STRANGER, '/here', 999));
    const silentInGroup = replies.length === 0 && toGroup().length === 0;
    reset();
    await bot.dispatch(groupMsg(STRANGER, '/poll Q | A | B', 999));
    const pollSilentInGroup = replies.length === 0 && toGroup().length === 0;
    check('a non-admin command in the group is answered with silence, not a line',
        silentInGroup && pollSilentInGroup,
        `here=${silentInGroup} poll=${pollSilentInGroup}`);

    // 29. /help described the broadcast and poll flow to anyone who typed it.
    reset();
    await bot.dispatch(dm(STRANGER, '/help'));
    const helpWithheld = replies.length === 1 && !/albums/i.test(replies[0]) && !/topic/i.test(replies[0]);
    reset();
    await bot.dispatch(dm(OWNER, '/help'));
    const helpForAdmin = replies.some((r) => /albums/i.test(r));
    check('/help withholds the capability list from a stranger, keeps it for an admin',
        helpWithheld && helpForAdmin,
        `strangerBlocked=${helpWithheld} adminWorks=${helpForAdmin}`);

    // 30. /start is the first thing anyone who finds the bot will send.
    reset();
    await bot.dispatch(dm(STRANGER, '/start'));
    const startWithheld = replies.length === 1 && !/albums/i.test(replies[0]);
    reset();
    await bot.dispatch(dm(STRANGER, '/cancel'));
    const cancelWithheld = replies.length === 1 && !/nothing to cancel/i.test(replies[0]);
    check('/start and /cancel tell a stranger nothing about the machinery',
        startWithheld && cancelWithheld,
        `start=${startWithheld} cancel=${cancelWithheld}`);

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
