# @drex-api/bot

Write a DrexChat bot in plain JavaScript. Long polling: no public address, no certificate, no dependencies.

```js
const { Bot } = require('@trashcore/drex-api');

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

## Buttons, video and audio (1.1)

```js
const { Bot, button, urlButton } = require('@trashcore/drex-api');

bot.command('play', (ctx) => ctx.reply('Pick one', {
  buttons: [[button('Truth', 'truth'), button('Dare', 'dare')], [urlButton('Docs', 'https://example.com')]]
}));

bot.action('truth', (ctx) => ctx.reply('...'));          // exact data
bot.action(/^page:(\d+)$/, (ctx) => ctx.reply('Page ' + ctx.match[1]));

ctx.replyWithVideo('https://host/clip.mp4', 'caption');
ctx.replyWithAudio('https://host/song.mp3');
```

Buttons: up to 8 rows, 4 per row. `data` is at most 64 bytes. Media must be a direct http(s) link to the file.
A tap nothing claims is emitted as `bot.on('callback', ...)`.

MIT licensed.
