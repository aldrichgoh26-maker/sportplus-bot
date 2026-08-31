// Drives the REAL telegraf composer -- no module stubbing -- with only the HTTP
// layer replaced. The suite in test/ stubs telegraf itself, so it cannot see the
// two things the real library actually requires: a bot_command ENTITY at offset 0
// (the stub matches with a regex), and ctx.me for the /cmd@username form. The last
// time this repo trusted a fully-stubbed suite, 11 green cases hid a real bug.

process.chdir(require('os').tmpdir());
const { Telegraf } = require('telegraf');
const { registerBroadcast } = require('../broadcast.js');

const GROUP = '-1004299960350';
const OWNER = 872399343;

const calls = [];
const bot = new Telegraf('123456:fake-token-not-used');
bot.botInfo = { id: 999, is_bot: true, first_name: 'ATHLO+', username: 'SportPlusSGBOT' };

// On the PROTOTYPE, not the instance. handleUpdate builds a brand new Telegram per
// update (telegraf.js:228) so ctx.reply and ctx.editMessageText go through a
// different object than the one registerBroadcast captured -- an instance-level
// stub silently lets half the calls out to the real API.
Object.getPrototypeOf(bot.telegram).callApi = async function (method, payload) {
    calls.push({ method, payload });
    if (method === 'getChatAdministrators') return [{ user: { id: OWNER } }];
    return { message_id: 5000 + calls.length, date: 1, chat: { id: payload.chat_id } };
};

registerBroadcast(bot, { chatId: GROUP, targets: [{ name: 'News', threadId: 397 }] });

const dm = (text, entities) => ({
    update_id: calls.length + 1,
    message: {
        message_id: 100 + calls.length, date: 1, text, entities,
        chat: { id: OWNER, type: 'private' },
        from: { id: OWNER, is_bot: false, first_name: 'Owner' },
    },
});
const tap = (data) => ({
    update_id: 900 + calls.length,
    callback_query: {
        id: 'cb1', chat_instance: 'ci', data,
        from: { id: OWNER, is_bot: false, first_name: 'Owner' },
        message: { message_id: 4242, date: 1, text: 'preview', chat: { id: OWNER, type: 'private' } },
    },
});

const CMD = [{ type: 'bot_command', offset: 0, length: 5 }];
const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
    if (detail) console.log(`        ${detail}`);
};

(async () => {
    // 1. Multi-line body behind a real bot_command entity.
    calls.length = 0;
    await bot.handleUpdate(dm('/poll Which race next?\nStandard Chartered\nSundown', CMD));
    const previewCall = calls.find((c) => c.method === 'sendMessage');
    const kb = previewCall?.payload?.reply_markup?.inline_keyboard || [];
    check('real composer routes a multi-line /poll to the preview',
        !!previewCall && /Which race next\?/.test(previewCall.payload.text)
        && !calls.some((c) => c.method === 'sendPoll'),
        `methods=${calls.map((c) => c.method).join(',')}`);

    // 2. The /cmd@botusername form a group client produces -- ctx.me is what decides
    //    it, and the stubbed suite has no ctx.me at all.
    calls.length = 0;
    await bot.handleUpdate(dm('/poll@SportPlusSGBOT At the gym? | Yes | No',
        [{ type: 'bot_command', offset: 0, length: '/poll@SportPlusSGBOT'.length }]));
    const p2 = calls.find((c) => c.method === 'sendMessage');
    check('/poll@SportPlusSGBOT is recognised and the handle is not left in the question',
        !!p2 && /At the gym\?/.test(p2.payload.text) && !/SportPlusSGBOT/.test(p2.payload.text),
        `text=${JSON.stringify(p2?.payload?.text)}`);

    // 3. Toggle, then send, through the real Context.
    const data = (kb.flat().find((b) => b.text.includes('News')) || {}).callback_data;
    calls.length = 0;
    await bot.handleUpdate(tap(data.replace(/:\d+$/, ':m')));
    const edit = calls.find((c) => c.method === 'editMessageText');
    check('a toggle reaches editMessageText with the redrawn text and keyboard',
        !!edit && /multiple answers/.test(edit.payload.text)
        && !!edit.payload.reply_markup?.inline_keyboard,
        `methods=${calls.map((c) => c.method).join(',')}`);

    calls.length = 0;
    await bot.handleUpdate(tap(data));
    const poll = calls.find((c) => c.method === 'sendPoll');
    // The payload is what actually goes on the wire, so assert it survives
    // JSON.stringify the way telegraf's JSON body builder will serialise it.
    const wire = poll && JSON.parse(JSON.stringify(poll.payload));
    check('sendPoll goes out with InputPollOption objects, thread and flags intact',
        !!poll && wire.chat_id === GROUP && wire.question === 'Which race next?'
        && JSON.stringify(wire.options) === JSON.stringify([{ text: 'Standard Chartered' }, { text: 'Sundown' }])
        && wire.type === 'regular' && wire.is_anonymous === true
        && wire.allows_multiple_answers === true && wire.message_thread_id === 397,
        `payload=${JSON.stringify(wire)}`);

    // 4. A bad shape must not reach Telegram.
    calls.length = 0;
    await bot.handleUpdate(dm('/poll Lonely question\nOnly one option', CMD));
    check('a one-option poll is refused before any sendPoll',
        !calls.some((c) => c.method === 'sendPoll')
        && /at least two options/i.test(calls.find((c) => c.method === 'sendMessage')?.payload?.text || ''),
        `methods=${calls.map((c) => c.method).join(',')}`);

    const failed = results.filter((r) => !r).length;
    console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed against real telegraf`);
    process.exit(failed ? 1 : 0);
})();
