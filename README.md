# @drex-api/bot

Write a DrexChat bot in plain JavaScript. Long polling: no public address, no certificate, no dependencies.

```js
const { Bot } = require('@drex-api/bot');

const bot = new Bot({ token: process.env.DREX_BOT_TOKEN, ownerId: Number(process.env.DREX_OWNER_ID) });

bot.command('start', (ctx) => ctx.reply('Hello'));
bot.on('message', (ctx) => ctx.reply('You said: ' + ctx.text));
bot.start();
```

Get a token with `?newbot` and your ID with `?getid`, both sent to DrexBot inside DrexChat.

## API
- `new Bot({ token, ownerId?, baseUrl?, pollTimeout?, quiet? })`
- `bot.command(name, handler)` matches `?name` or `/name`
- `bot.on('message' | 'ready', handler)`
- `bot.sendMessage(chatId, text)`, `bot.sendPhoto(chatId, url, caption?)`, `bot.getMe()`
- `bot.start()` / `bot.stop()`
- `ctx.reply(text)`, `ctx.replyWithPhoto(url, caption?)`, `ctx.text`, `ctx.command`, `ctx.fromUsername`, `ctx.chatId`

MIT licensed.
