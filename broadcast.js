'use strict';

// Admin broadcast: an admin DMs the bot, the bot shows the message back as a
// preview, and nothing reaches the group until a button is tapped.
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
function stripLeadingPost(text, entities) {
    const raw = String(text ?? '');
    const m = /^\/post(?:@[A-Za-z0-9_]+)?(?:\s+|$)/.exec(raw);
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
    'Send me the message you want to put in the group -- text, or a photo with a caption.',
    'I will show it back to you with a button for each topic. Nothing is posted until you tap one.',
    '',
    'Formatting you apply here (bold, italics, links) is carried through exactly.',
    '',
    '/here -- show the id of the topic this was typed in',
    '/cancel -- drop your most recent draft',
    '/help -- this message',
].join('\n');

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

    const keyboardFor = (id) => {
        const rows = [];
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

    // Drafting happens ONLY in private chats. Doing it in the group would mean the
    // half-written version is already public, which defeats the point of a preview.
    bot.on('message', async (ctx) => {
        if (ctx.chat?.type !== 'private') return;

        // Deny by default, and say nothing about why. A stranger who finds the bot
        // learns what it is for, not who can drive it.
        if (!(await isAdmin(ctx.from.id))) {
            await ctx.reply('This bot posts updates to the SportPlus | ATHLO+ group.');
            return;
        }

        const msg = ctx.message || {};
        const photo = Array.isArray(msg.photo) && msg.photo.length
            ? msg.photo[msg.photo.length - 1].file_id   // last entry is the largest
            : null;

        const source = photo ? msg.caption : msg.text;
        if (source == null) {
            await ctx.reply('Text and photos only for now. A photo needs a caption.');
            return;
        }

        const { text, entities } = stripLeadingPost(
            source,
            photo ? msg.caption_entities : msg.entities
        );

        // An unrecognised command is a typo, not a broadcast. Drafting it would put
        // "/annonuce" in front of the confirm button and invite a tap.
        if (!photo && text.startsWith('/')) {
            await ctx.reply('Unknown command. /help for what I can do.');
            return;
        }
        if (!text.trim()) {
            await ctx.reply('That is empty -- nothing to send.');
            return;
        }

        const id = drafts.put({ from: ctx.from.id, text, entities, photo });
        const markup = keyboardFor(id);

        // The preview IS the message: same text, same entities, same photo. There is
        // no second rendering path that could differ from what the group will see.
        try {
            if (photo) {
                await telegram.sendPhoto(ctx.chat.id, photo, {
                    caption: text,
                    caption_entities: entities.length ? entities : undefined,
                    reply_markup: markup,
                });
            } else {
                await telegram.sendMessage(ctx.chat.id, text, {
                    entities: entities.length ? entities : undefined,
                    reply_markup: markup,
                });
            }
        } catch (err) {
            drafts.delete(id);
            const why = err?.response?.description || err?.message;
            console.error('❌ Could not show the broadcast preview:', why);
            await ctx.reply(`Could not build a preview: ${why}`);
        }
    });

    // A receipt that cannot be delivered still has to be loud somewhere, because the
    // admin is now looking at a screen that says nothing about whether it worked --
    // the exact ambiguity the confirm gate exists to remove.
    const say = (ctx, text) => ctx.reply(text).catch((err) => {
        console.error('⚠️ Could not deliver the receipt DM:', err?.response?.description || err?.message);
    });

    bot.on('callback_query', async (ctx) => {
        const data = ctx.callbackQuery?.data || '';
        const m = /^bc:([A-Za-z0-9_-]+):(\d+|x)$/.exec(data);
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
            sent = draft.photo
                ? await telegram.sendPhoto(chatId, draft.photo, {
                    caption: draft.text,
                    caption_entities: draft.entities.length ? draft.entities : undefined,
                    message_thread_id: thread,
                })
                : await telegram.sendMessage(chatId, draft.text, {
                    entities: draft.entities.length ? draft.entities : undefined,
                    message_thread_id: thread,
                });
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

    console.log(`📣 Broadcast ready. Topics: ${targets.map((t) => `${t.name}=${t.threadId ?? 'General'}`).join(', ')}`);
    return { drafts, targets, isAdmin };
}

module.exports = {
    registerBroadcast,
    parseTargets,
    stripLeadingPost,
    messageLink,
    makeAdminGate,
    makeDraftStore,
};
