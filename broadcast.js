'use strict';

// Admin broadcast: an admin DMs the bot, the bot shows the message back as a
// preview, and nothing reaches the group until a button is tapped. Polls ride the
// same gate -- see the Polls section for why they cannot ride the same INPUT.
//
// The confirm gate is the whole design. Posting into a public group is not
// undoable in any meaningful sense -- people have already read it -- so the
// cost of a stray keystroke has to be a tap, not a send.
//
// Everything here rides long polling, which on this host has a history of being
// down for a week at a time. That is why every accepted input gets an immediate
// reply: silence must be readable as "it did not arrive", never as "it might
// have". Telegram queues undelivered updates for ~24h, so a draft typed into a
// dead bot surfaces later out of nowhere -- and lands on the confirm gate, not
// in the group.

const crypto = require('crypto');

const DRAFT_TTL_MS = 15 * 60 * 1000;
const DRAFT_MAX = 50;
const ADMIN_CACHE_TTL_MS = 60 * 1000;
// How long a cached admin list may be trusted once the API stops answering.
// Locking every admin out over a transient blip is worse than briefly honouring
// a promotion that has since been revoked; a whole hour of failure is not a blip.
const ADMIN_CACHE_STALE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// "Announcements:0,News:286" -> [{name:'Announcements',threadId:null},{name:'News',threadId:286}]
//
// Thread 0 / empty means General, which is not addressable by id: the Bot API
// wants message_thread_id omitted entirely, so General is modelled as null and
// never as 0.
function parseTargets(spec) {
    const fallback = [{ name: 'General', threadId: null }];
    if (!spec || !String(spec).trim()) return fallback;

    const out = [];
    for (const part of String(spec).split(',')) {
        if (!part.trim()) continue;
        const idx = part.lastIndexOf(':');
        const name = (idx === -1 ? part : part.slice(0, idx)).trim();
        const raw = (idx === -1 ? '' : part.slice(idx + 1)).trim();
        if (!name) {
            console.warn(`⚠️ BROADCAST_TOPICS: skipping nameless target "${part.trim()}"`);
            continue;
        }
        if (raw && !/^\d+$/.test(raw)) {
            console.warn(`⚠️ BROADCAST_TOPICS: skipping "${name}" -- "${raw}" is not a thread id`);
            continue;
        }
        const threadId = !raw || raw === '0' ? null : Number(raw);
        out.push({ name: name.slice(0, 24), threadId });
        if (out.length === 6) break;   // keeps the keyboard to three rows of two
    }
    return out.length ? out : fallback;
}

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

// Broadcasts are sent as text + entities, never parse_mode. Entities are what the
// admin's own Telegram client produced when they bolded a word or pasted a link,
// so what they typed is exactly what the group gets -- and a stray "<" or "*" in
// a normal sentence can no longer 400 the whole post, which is the same class of
// bug that used to drop news articles.

// Offsets are UTF-16 code units, which is also how JS indexes strings, so plain
// slicing stays in step with them -- including across emoji surrogate pairs.
function stripLeadingPost(text, entities, command = 'post') {
    const raw = String(text ?? '');
    const m = new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?(?:\\s+|$)`).exec(raw);
    if (!m) return { text: raw, entities: entities || [] };

    const cut = m[0].length;
    const shifted = [];
    for (const e of entities || []) {
        const end = e.offset + e.length;
        if (end <= cut) continue;                       // lived entirely in the command
        const offset = Math.max(0, e.offset - cut);
        const length = e.offset >= cut ? e.length : end - cut;
        if (length > 0) shifted.push({ ...e, offset, length });
    }
    return { text: raw.slice(cut), entities: shifted };
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

// A poll cannot be handed to the bot the way a photo can. Telegram's clients only
// offer the poll composer in groups and channels -- there is no Poll button in a
// one-to-one chat with a bot -- so the admin types it and the preview is our own
// rendering of what the group will get, not a real poll bounced back.
//
// That rendering is the last place a typo can be caught, and it matters more here
// than for a message: there is no editMessageText for a poll. A wrong poll can only
// be deleted and re-run, and every vote already cast goes with it.

const POLL_QUESTION_MAX = 300;   // sendPoll: "Poll question, 1-300 characters"
const POLL_OPTION_MAX = 100;     // InputPollOption.text: "Option text, 1-100 characters"
const POLL_OPTIONS_MAX = 12;     // sendPoll: "a JSON-serialized list of 1-12 answer options"
// The API's own floor is 1. One option is not a poll anybody meant to write -- it is
// what you get when the separators were wrong -- so reject it here, where we can say
// so, rather than posting a poll with a single button.
const POLL_OPTIONS_MIN = 2;

// Telegram counts characters; JS counts UTF-16 code units, so "🏃" is 1 to them and 2
// to .length. Counting code points keeps an emoji-heavy question from being refused
// for a limit it never reached.
const charLen = (s) => [...String(s)].length;

// An admin writing a list writes it as a list. Neither "1." nor "-" belongs in the
// option text -- Telegram numbers the options itself.
const stripBullet = (s) => String(s).replace(/^\s*(?:[-*•–—]|\d{1,2}[.)])\s+/, '').trim();

// Enter SENDS on Telegram Desktop, so one option per line costs a shift-enter each
// and a slip mid-draft fires a half-written poll at the bot. A single line split on
// "|" is the same poll with no shift-enters, so accept both and let the shape of
// what arrived decide which it was: more than one line means lines.
function parsePoll(raw) {
    const body = String(raw ?? '').trim();
    if (!body) return { error: 'usage' };

    const lines = body.split('\n').map((s) => s.trim()).filter(Boolean);
    const fields = lines.length > 1 ? lines : lines[0].split('|').map((s) => s.trim()).filter(Boolean);

    const question = fields.shift() || '';
    const options = fields.map(stripBullet).filter(Boolean);

    if (!question) return { error: 'usage' };
    if (options.length < POLL_OPTIONS_MIN) return { error: 'usage' };
    if (options.length > POLL_OPTIONS_MAX) {
        return { error: `That is ${options.length} options -- Telegram caps a poll at ${POLL_OPTIONS_MAX}.` };
    }
    if (charLen(question) > POLL_QUESTION_MAX) {
        return { error: `The question is ${charLen(question)} characters; Telegram caps it at ${POLL_QUESTION_MAX}.` };
    }
    const long = options.findIndex((o) => charLen(o) > POLL_OPTION_MAX);
    if (long !== -1) {
        return { error: `Option ${long + 1} is ${charLen(options[long])} characters; Telegram caps each one at ${POLL_OPTION_MAX}.` };
    }

    return { question, options };
}

const pollFooter = (d) =>
    `${d.isAnonymous ? '🕶 Anonymous' : '👤 Names shown'} · ${d.multiple ? 'multiple answers' : 'one answer'}`;

// Sent as plain text, no parse_mode -- same reasoning as a broadcast. The question
// is the admin's own words and a stray "<" in it must not 400 the preview.
function renderPoll(draft) {
    return [
        `🗳 ${draft.question}`,
        '',
        ...draft.options.map((o, i) => `${i + 1}. ${o}`),
        '',
        pollFooter(draft),
    ].join('\n');
}

const POLL_USAGE = [
    'A poll is a question and at least two options.',
    '',
    '/poll Which race should we cover next?',
    'Standard Chartered',
    'Sundown',
    '',
    'One option per line (shift+enter on desktop), or all on one line separated by "|":',
    '',
    '/poll Which race? | Standard Chartered | Sundown',
    '',
    'Anonymous and one-answer by default -- both are buttons on the preview.',
].join('\n');

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

// Nothing is ever downloaded or re-uploaded. An admin's own client does the upload
// once, into the DM, and Telegram hands us a file_id; broadcasting re-sends that id.
// So a 300 MB reel costs this process nothing but a JSON round trip, and the bot's
// own 50 MB upload ceiling never comes into it.
//
// ORDER MATTERS. A GIF arrives with BOTH `animation` and `document` populated, so
// animation has to be tested first or every GIF goes out as a silent file
// attachment. Photo is first only because it is the common case.
const MEDIA_KINDS = [
    { field: 'photo', type: 'photo', send: 'sendPhoto', id: (v) => v[v.length - 1].file_id },
    { field: 'animation', type: 'animation', send: 'sendAnimation', id: (v) => v.file_id },
    { field: 'video', type: 'video', send: 'sendVideo', id: (v) => v.file_id },
    { field: 'document', type: 'document', send: 'sendDocument', id: (v) => v.file_id },
];

function readMedia(msg) {
    for (const k of MEDIA_KINDS) {
        const v = msg[k.field];
        if (v) return { type: k.type, send: k.send, fileId: k.id(v) };
    }
    return null;
}

// sendMediaGroup accepts photo, video, audio and document -- NOT animation -- and
// refuses to mix documents with anything else. Rejecting up front with a specific
// reason beats letting Telegram 400 the whole album at confirm time, when the admin
// has already been shown a preview and told it was ready to go.
function albumProblem(items) {
    const kinds = new Set(items.map((i) => i.media.type));
    if (kinds.has('animation')) return 'GIFs cannot go in an album -- send it on its own.';
    if (kinds.has('document') && kinds.size > 1) return 'Files cannot be mixed with photos or videos in one album.';
    if (items.length > 10) return 'Telegram caps an album at 10 items.';
    return null;
}

// An album shows ONE caption, taken from whichever item carries it. Putting it on
// index 0 is what makes the text appear under the group as a whole rather than
// buried on the third clip.
function albumPayload(draft) {
    return draft.media.map((m, i) => ({
        type: m.type,
        media: m.fileId,
        ...(i === 0 && draft.text
            ? {
                caption: draft.text,
                caption_entities: draft.entities.length ? draft.entities : undefined,
            }
            : {}),
    }));
}

// t.me/c/<id> links work for members of a private-by-id supergroup, which every
// admin is. The -100 prefix is a Bot API artefact and is not part of the link.
function messageLink(chatId, threadId, messageId) {
    const m = /^-100(\d+)$/.exec(String(chatId));
    if (!m || !messageId) return null;
    return threadId
        ? `https://t.me/c/${m[1]}/${threadId}/${messageId}`
        : `https://t.me/c/${m[1]}/${messageId}`;
}

// ---------------------------------------------------------------------------
// Who is allowed to broadcast
// ---------------------------------------------------------------------------

// Ask Telegram who the admins are rather than keeping a list. A list drifts the
// moment someone is promoted, and the obvious shortcut -- matching @usernames --
// is the exact trap that pointed this bot at a dead chat for two months: a
// username is a display name that can be released and re-registered by anyone.
// Numeric ids are the only stable identity Telegram gives us.
function makeAdminGate({ telegram, chatId, staticIds = [], now = Date.now }) {
    const pinned = new Set(staticIds.map(Number).filter(Number.isFinite));
    let cache = null;   // { at, ids }

    return async function isAdmin(userId) {
        const id = Number(userId);
        if (!Number.isFinite(id)) return false;
        if (pinned.has(id)) return true;

        const t = now();
        if (!cache || t - cache.at > ADMIN_CACHE_TTL_MS) {
            try {
                const admins = await telegram.getChatAdministrators(chatId);
                cache = { at: t, ids: new Set(admins.map((a) => a.user.id)) };
            } catch (err) {
                const why = err?.response?.description || err?.message;
                // Fail CLOSED. Publishing is not a read: "we could not check" has
                // to mean no, or an outage becomes an open door.
                if (!cache || t - cache.at > ADMIN_CACHE_STALE_MS) {
                    console.error(`⚠️ Cannot verify admins (${why}) -- refusing the broadcast.`);
                    return false;
                }
                console.warn(`⚠️ Cannot refresh admins (${why}) -- using the cached list.`);
            }
        }
        return cache.ids.has(id);
    };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

function makeDraftStore({ now = Date.now } = {}) {
    const drafts = new Map();   // insertion-ordered, so the first key is the oldest

    function sweep() {
        const t = now();
        for (const [id, d] of drafts) {
            if (t - d.createdAt > DRAFT_TTL_MS) drafts.delete(id);
        }
        while (drafts.size > DRAFT_MAX) drafts.delete(drafts.keys().next().value);
    }

    return {
        put(draft) {
            sweep();
            const id = crypto.randomBytes(6).toString('base64url');
            drafts.set(id, { ...draft, createdAt: now(), sending: false, sent: false });
            return id;
        },
        get(id) {
            sweep();
            return drafts.get(id) || null;
        },
        delete: (id) => drafts.delete(id),
        newestFrom(userId) {
            sweep();
            let found = null;
            for (const [id, d] of drafts) if (d.from === userId && !d.sent) found = { id, draft: d };
            return found;
        },
        get size() { return drafts.size; },
    };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const HELP = [
    'Send me what you want to put in the group. I will show it back to you with a button',
    'for each topic -- nothing is posted until you tap one.',
    '',
    'Works with: text, photos, videos, GIFs, files, and albums (several photos or videos',
    'sent together). Add a caption and it rides along.',
    '',
    'Formatting you apply here (bold, italics, links) is carried through exactly.',
    '',
    '/poll -- start a poll. Question on the first line, one option per line after it,',
    '        or all on one line separated by "|". Anonymous and one-answer by',
    '        default; both are buttons on the preview.',
    '',
    '/here -- show the id of the topic this was typed in',
    '/cancel -- drop your most recent draft',
    '/help -- this message',
].join('\n');

// Deny by default, and say nothing about why. A stranger who finds the bot learns
// what it is for, not who can drive it. It is a line rather than silence because on
// this host silence is genuinely ambiguous -- the bot has been down for a week at a
// time, and "no answer" has to keep meaning that.
const NOT_FOR_YOU = 'This bot posts updates to the SportPlus | ATHLO+ group.';

// Telegram splits an album into one update PER ITEM, all sharing a media_group_id,
// delivered back to back. There is no "album finished" signal, so the only way to
// know we have them all is to wait for the arrivals to stop. Everything buffered
// under one id becomes a single draft with a single confirm button -- otherwise a
// three-clip album would ask the admin to tap three times and post three times.
// Configurable only so the test suite does not have to sleep through it for real.
// Raising it in production would make the bot feel slow to answer; lowering it risks
// splitting a slow album into two drafts.
const ALBUM_SETTLE_MS = Number(process.env.BROADCAST_ALBUM_SETTLE_MS || 1500);

function registerBroadcast(bot, opts) {
    const {
        telegram = bot.telegram,
        chatId,
        targets = parseTargets(process.env.BROADCAST_TOPICS),
        adminIds = String(process.env.BROADCAST_ADMIN_IDS || '').split(',').filter(Boolean),
        drafts = makeDraftStore(),
        isAdmin = makeAdminGate({ telegram, chatId, staticIds: adminIds }),
    } = opts;

    if (!chatId) {
        console.warn('⚠️ Broadcast disabled: no CHANNEL_ID.');
        return { drafts, targets };
    }

    // A poll draft gets two extra buttons above the topics. They show the state the
    // poll is IN, not the state a tap would move it to -- the same convention as the
    // footer line in the preview text, which is edited in step with them so the two
    // can never disagree.
    const keyboardFor = (id, draft) => {
        const rows = [];
        if (draft?.kind === 'poll') {
            rows.push([
                { text: draft.isAnonymous ? '🕶 Anonymous' : '👤 Names shown', callback_data: `bc:${id}:a` },
                { text: draft.multiple ? '🔢 Multiple answers' : '☝️ One answer', callback_data: `bc:${id}:m` },
            ]);
        }
        for (let i = 0; i < targets.length; i += 2) {
            rows.push(targets.slice(i, i + 2).map((t, j) => ({
                text: `📣 ${t.name}`,
                callback_data: `bc:${id}:${i + j}`,
            })));
        }
        rows.push([{ text: '✖️ Cancel', callback_data: `bc:${id}:x` }]);
        return { inline_keyboard: rows };
    };

    bot.command('here', async (ctx) => {
        const thread = ctx.message?.message_thread_id;
        await ctx.reply(
            `chat id: ${ctx.chat.id}\n` +
            `topic id: ${thread ?? '(none -- this is General, or a private chat)'}\n\n` +
            'Put these in BROADCAST_TOPICS as Name:id, comma separated.'
        );
    });

    const help = async (ctx) => {
        if (ctx.chat?.type !== 'private') return;
        await ctx.reply(HELP);
    };
    bot.command('help', help);
    bot.command('start', help);

    bot.command('cancel', async (ctx) => {
        if (ctx.chat?.type !== 'private') return;
        const found = drafts.newestFrom(ctx.from.id);
        if (!found) return void await ctx.reply('Nothing to cancel.');
        drafts.delete(found.id);
        await ctx.reply('Draft dropped.');
    });

    bot.command('poll', async (ctx) => {
        // Drafting in the group would put the half-written version in front of the
        // people it is for, which is the whole thing the preview exists to prevent.
        // Answer anyway rather than ignoring it: an admin who types /poll in a topic
        // and gets nothing back has no way to tell that from the bot being down --
        // and on this host that is a real possibility, not a hypothetical one. Only
        // admins get the nudge, so a member cannot use it to make the bot talk.
        if (ctx.chat?.type !== 'private') {
            if (await isAdmin(ctx.from.id)) {
                await ctx.reply('Send /poll to me in a DM -- you get a preview there, and a poll cannot be edited once it is posted.');
            }
            return;
        }
        if (!(await isAdmin(ctx.from.id))) return void await ctx.reply(NOT_FOR_YOU);

        const { text } = stripLeadingPost(ctx.message?.text ?? '', [], 'poll');
        const parsed = parsePoll(text);
        if (parsed.error) return void await ctx.reply(parsed.error === 'usage' ? POLL_USAGE : parsed.error);

        await showPollPreview(ctx.chat.id, {
            from: ctx.from.id,
            kind: 'poll',
            question: parsed.question,
            options: parsed.options,
            isAnonymous: true,
            multiple: false,
        });
    });

    const albums = new Map();   // media_group_id -> { items, from, chatId, timer }

    // The preview IS the message: same text, same entities, same file ids. There is
    // no second rendering path that could differ from what the group will see.
    // The toggles mutate the STORED draft, so read it back rather than rendering the
    // caller's object -- drafts.put() copies, and a preview drawn from the copy would
    // stop matching what the buttons are editing after the first tap.
    async function showPollPreview(chatId, draft) {
        const id = drafts.put(draft);
        const stored = drafts.get(id);
        try {
            await telegram.sendMessage(chatId, renderPoll(stored), { reply_markup: keyboardFor(id, stored) });
        } catch (err) {
            drafts.delete(id);
            const why = err?.response?.description || err?.message;
            console.error('❌ Could not show the poll preview:', why);
            await telegram.sendMessage(chatId, `Could not build a preview: ${why}`).catch(() => {});
        }
    }

    async function showPreview(chatId, draft) {
        const id = drafts.put(draft);
        const markup = keyboardFor(id, draft);
        try {
            if (draft.media.length > 1) {
                // sendMediaGroup takes no reply_markup -- an album physically cannot
                // carry buttons -- so the confirm has to be its own message underneath.
                await telegram.sendMediaGroup(chatId, albumPayload(draft));
                await telegram.sendMessage(chatId, `☝️ ${draft.media.length} items. Send this album to:`, { reply_markup: markup });
            } else if (draft.media.length === 1) {
                const m = draft.media[0];
                await telegram[m.send](chatId, m.fileId, {
                    caption: draft.text || undefined,
                    caption_entities: draft.text && draft.entities.length ? draft.entities : undefined,
                    reply_markup: markup,
                });
            } else {
                await telegram.sendMessage(chatId, draft.text, {
                    entities: draft.entities.length ? draft.entities : undefined,
                    reply_markup: markup,
                });
            }
        } catch (err) {
            drafts.delete(id);
            const why = err?.response?.description || err?.message;
            console.error('❌ Could not show the broadcast preview:', why);
            await telegram.sendMessage(chatId, `Could not build a preview: ${why}`).catch(() => {});
        }
    }

    async function flushAlbum(groupId) {
        const pending = albums.get(groupId);
        if (!pending) return;
        albums.delete(groupId);

        // Telegram usually delivers in order, but the contract is per-update, not
        // per-album, so sort rather than trust it -- the order here is the order the
        // group sees.
        pending.items.sort((a, b) => a.messageId - b.messageId);

        const problem = albumProblem(pending.items);
        if (problem) {
            await telegram.sendMessage(pending.chatId, `Cannot send that album: ${problem}`).catch(() => {});
            return;
        }

        // Clients attach the caption to whichever item the user typed it on, which is
        // normally the first -- take the first one that actually carries text.
        const captioned = pending.items.find((i) => i.text && i.text.trim());
        await showPreview(pending.chatId, {
            from: pending.from,
            text: captioned ? captioned.text : '',
            entities: captioned ? captioned.entities : [],
            media: pending.items.map((i) => i.media),
        });
    }

    // Drafting happens ONLY in private chats. Doing it in the group would mean the
    // half-written version is already public, which defeats the point of a preview.
    bot.on('message', async (ctx) => {
        if (ctx.chat?.type !== 'private') return;

        if (!(await isAdmin(ctx.from.id))) {
            await ctx.reply(NOT_FOR_YOU);
            return;
        }

        const msg = ctx.message || {};
        const media = readMedia(msg);

        const source = media ? msg.caption : msg.text;
        if (media == null && source == null) {
            // Named explicitly: a round video reads as "a video" to the person who
            // sent it, and Telegram gives it no caption field at all, so a silent
            // "unsupported" would look like the bot dropping their announcement.
            const why = msg.video_note ? 'Round videos carry no caption, so they cannot be a broadcast.'
                : msg.voice || msg.audio ? 'Audio is not supported yet.'
                    : 'I can send text, photos, videos, GIFs, files and albums.';
            await ctx.reply(why);
            return;
        }

        const { text, entities } = stripLeadingPost(
            source ?? '',
            media ? msg.caption_entities : msg.entities
        );

        // An unrecognised command is a typo, not a broadcast. Drafting it would put
        // "/annonuce" in front of the confirm button and invite a tap.
        if (!media && text.startsWith('/')) {
            await ctx.reply('Unknown command. /help for what I can do.');
            return;
        }
        if (!media && !text.trim()) {
            await ctx.reply('That is empty -- nothing to send.');
            return;
        }

        // One item of an album. Buffer it and restart the settle timer; the LAST
        // arrival is the one that actually builds the draft.
        if (media && msg.media_group_id) {
            const gid = String(msg.media_group_id);
            let pending = albums.get(gid);
            if (!pending) {
                pending = { items: [], from: ctx.from.id, chatId: ctx.chat.id, timer: null };
                albums.set(gid, pending);
            }
            pending.items.push({ messageId: msg.message_id, media, text, entities });
            clearTimeout(pending.timer);
            pending.timer = setTimeout(() => {
                flushAlbum(gid).catch((err) => console.error('❌ Album preview failed:', err?.message));
            }, ALBUM_SETTLE_MS);
            return;
        }

        await showPreview(ctx.chat.id, {
            from: ctx.from.id,
            text,
            entities,
            media: media ? [media] : [],
        });
    });

    // A receipt that cannot be delivered still has to be loud somewhere, because the
    // admin is now looking at a screen that says nothing about whether it worked --
    // the exact ambiguity the confirm gate exists to remove.
    const say = (ctx, text) => ctx.reply(text).catch((err) => {
        console.error('⚠️ Could not deliver the receipt DM:', err?.response?.description || err?.message);
    });

    bot.on('callback_query', async (ctx) => {
        const data = ctx.callbackQuery?.data || '';
        const m = /^bc:([A-Za-z0-9_-]+):(\d+|x|a|m)$/.exec(data);
        if (!m) return;

        const answer = (text) => ctx.answerCbQuery(text).catch(() => {});
        const [, id, choice] = m;
        const draft = drafts.get(id);

        // Drafts live in memory, so a restart between typing and tapping loses them.
        // Better to say so than to reconstruct something the admin cannot see.
        if (!draft) return void await answer('Draft expired -- send it again.');
        if (draft.from !== ctx.from.id) return void await answer('Only the admin who wrote this can send it.');
        if (!(await isAdmin(ctx.from.id))) return void await answer('Not allowed.');

        if (choice === 'x') {
            drafts.delete(id);
            await ctx.editMessageReplyMarkup(undefined).catch(() => {});
            return void await answer('Cancelled.');
        }

        // Anonymity and multiple-answers are fixed at creation -- sendPoll takes them
        // and no API call can change them afterwards -- so the only moment they can be
        // set is before the topic button is tapped. Guarded by the same sent/sending
        // flags as the send itself: a toggle racing a send would decide the poll's
        // shape after the payload was already on its way.
        if (choice === 'a' || choice === 'm') {
            if (draft.kind !== 'poll') return void await answer('Nothing to change here.');
            if (draft.sent) return void await answer('Already sent.');
            if (draft.sending) return void await answer('Still sending...');

            if (choice === 'a') draft.isAnonymous = !draft.isAnonymous;
            else draft.multiple = !draft.multiple;

            await ctx.editMessageText(renderPoll(draft), { reply_markup: keyboardFor(id, draft) }).catch((err) => {
                console.warn('⚠️ Could not redraw the poll preview:', err?.response?.description || err?.message);
            });
            return void await answer(pollFooter(draft));
        }

        const target = targets[Number(choice)];
        if (!target) return void await answer('That topic is no longer configured.');

        // Idempotency. Telegram will happily deliver the same callback twice on a
        // double tap or a flaky connection, and the second one must not post again.
        if (draft.sent) return void await answer('Already sent.');
        if (draft.sending) return void await answer('Still sending...');
        draft.sending = true;

        // This try guards the SEND and nothing else. Everything after it -- the
        // toast, the receipt, clearing the buttons -- is bookkeeping about a message
        // that is already in the group, and folding it in here once meant a failed
        // receipt was reported as a failed broadcast: "not sent, tap again to retry"
        // for a post every member had already read.
        let sent;
        try {
            const thread = target.threadId ?? undefined;
            if (draft.kind === 'poll') {
                // options is an array of InputPollOption, not of strings: the Bot API
                // changed that in 7.3 and telegraf 4.16.3 predates it, so its typings
                // still say string[]. It passes the value straight through to a JSON
                // body, so the objects arrive as the current API wants them.
                sent = await telegram.sendPoll(
                    chatId,
                    draft.question,
                    draft.options.map((text) => ({ text })),
                    {
                        is_anonymous: draft.isAnonymous,
                        allows_multiple_answers: draft.multiple,
                        message_thread_id: thread,
                    },
                );
            } else if (draft.media.length > 1) {
                // sendMediaGroup answers with an ARRAY of messages, one per item.
                // The first is what the message link should point at.
                const group = await telegram.sendMediaGroup(chatId, albumPayload(draft), { message_thread_id: thread });
                sent = Array.isArray(group) ? group[0] : group;
            } else if (draft.media.length === 1) {
                const m = draft.media[0];
                sent = await telegram[m.send](chatId, m.fileId, {
                    caption: draft.text || undefined,
                    caption_entities: draft.text && draft.entities.length ? draft.entities : undefined,
                    message_thread_id: thread,
                });
            } else {
                sent = await telegram.sendMessage(chatId, draft.text, {
                    entities: draft.entities.length ? draft.entities : undefined,
                    message_thread_id: thread,
                });
            }
        } catch (err) {
            draft.sending = false;
            const why = err?.response?.description || err?.message;
            console.error(`❌ Broadcast to ${target.name} failed:`, why);
            await answer('Failed -- see the message below.');
            await say(ctx, `❌ Not sent: ${why}\n\nThe draft is still here -- tap again to retry.`);
            return;
        }

        draft.sent = true;
        draft.sending = false;

        const link = messageLink(chatId, target.threadId, sent?.message_id);
        console.log(`📣 Broadcast to ${target.name} by ${ctx.from.id} (message ${sent?.message_id})`);
        await ctx.editMessageReplyMarkup(undefined).catch(() => {});
        await answer(`Sent to ${target.name}.`);
        await say(ctx, `✅ Sent to ${target.name}.${link ? `\n${link}` : ''}`);
    });

    // "Bot is awake!" comes back from every version ever deployed, so HTTP cannot tell
    // you which commit is live. This line can, which is why it names the features and
    // not just the topics -- change it whenever they change.
    console.log(`📣 Broadcast + polls ready. Topics: ${targets.map((t) => `${t.name}=${t.threadId ?? 'General'}`).join(', ')}`);
    return { drafts, targets, isAdmin };
}

module.exports = {
    registerBroadcast,
    parseTargets,
    parsePoll,
    renderPoll,
    stripLeadingPost,
    messageLink,
    makeAdminGate,
    makeDraftStore,
    readMedia,
    albumProblem,
    albumPayload,
};
