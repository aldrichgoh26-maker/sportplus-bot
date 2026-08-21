# Group content

The pinned welcome and the topic starter posts for `SportPlus | ATHLO +`
(`-1004299960350`), kept here because on 2026-08-21 an admin deleted every message in
the group and **none of this existed anywhere else**. The Bot API cannot read history,
so once those messages were gone the text was gone. What survives below was
reconstructed from a screenshot that happened to have been taken 40 minutes earlier.

These files are the source of truth for the *text*. They are not synced with Telegram:
if someone edits the pinned message in the app, edit it here too, or the next restore
quietly reverts their change.

| File | Goes to | Notes |
|---|---|---|
| `welcome.html` | General | Pinned. Its message id feeds `DISCUSS_URL`. |
| `topic-180-train-and-race.html` | thread `180` | |
| `topic-173-gear-and-marketplace.html` | thread `173` | |

`NEWS` (thread `286`) is not seeded by hand — it is the bot's own output. To refill it,
let the feed repost run rather than writing posts here.

## Restoring

```bash
BOT_TOKEN=... node group/seed.js            # dry run: prints what it would send
BOT_TOKEN=... node group/seed.js --confirm   # actually posts and pins
```

It prints the new pinned message id at the end. **That id must then be written to
`DISCUSS_URL` on Render** (and to the default in `bot.js`), or every news post's CTA
points at a message that no longer exists and silently degrades to the group page.

## Formatting

Parse mode is HTML, so `&` must be written `&amp;` — an unescaped one makes Telegram
reject the whole message. Everything else here is literal, including the emoji and the
`•` bullets.

General is addressed by **omitting** `message_thread_id`. There is no id for it:
`message_thread_id=1` is refused with "message thread not found".
