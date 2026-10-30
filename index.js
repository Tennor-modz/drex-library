'use strict';

/**
 * drexbot — write a DrexChat bot in plain JavaScript and run it anywhere.
 *
 * A bot reaches DrexChat by long polling, so it needs no public address, no certificate and no
 * inbound firewall rule: it can sit on a laptop, a Raspberry Pi or a free host and still receive
 * messages. There are no dependencies — the whole library is this file.
 *
 *   const { Bot } = require('drexbot-api');
 *
 *   const bot = new Bot({ token: process.env.DREX_BOT_TOKEN, ownerId: 12345 });
 *   bot.command('start', (ctx) => ctx.reply('Hello'));
 *   bot.on('message', (ctx) => ctx.reply('You said: ' + ctx.text));
 *   bot.start();
 *
 * Get a token by sending ?newbot to DrexBot inside DrexChat, and your own ID with ?getid.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_BASE_URL = 'https://backend.drexapp.space';
/*
   Ten seconds, not the usual thirty: a poll is a request held open on purpose, and the proxy in
   front of the API will kill one that outlives its read timeout — which arrives as a 502 at the bot,
   where it looks like the server is broken. Ten is long enough that an idle bot is not chatty (one
   request every ten seconds) and short enough to survive a proxy that allows thirty.
*/
const DEFAULT_POLL_SECONDS = 10;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The first word of a message, without its command prefix. */
function commandName(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  const match = /^[?/]([A-Za-z0-9_]+)$/.exec(first);
  return match ? match[1].toLowerCase() : null;
}

class Bot {
  /**
   * @param {object} options
   * @param {string} options.token    the bot token from DrexBot (?newbot), required
   * @param {number} [options.ownerId] your DrexChat user ID, from ?getid
   * @param {string} [options.baseUrl] the DrexChat server, defaulted
   * @param {number} [options.pollTimeout] seconds the server may hold a poll open (0-50). Ten by
   *   default: a request held open for longer than the proxy in front of the API allows comes back
   *   as a 502, and the bot then looks broken while nothing is actually wrong with it.
   * @param {boolean} [options.quiet]       silence the library's own logging
   */
  constructor(options) {
    const opts = options || {};
    if (!opts.token || typeof opts.token !== 'string') {
      throw new Error('A bot token is required. Send ?newbot to DrexBot in DrexChat to get one.');
    }
    this.token = opts.token.trim();
    this.ownerId = opts.ownerId != null ? opts.ownerId : null;
    this.baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.pollTimeout = clampPoll(opts.pollTimeout);
    this.quiet = Boolean(opts.quiet);

    this.me = null;
    this.offset = 0;
    this.running = false;
    this.handlers = new Map();
    this.commands = new Map();
    this.actions = [];
    this._backoff = BACKOFF_START_MS;
  }

  /* ------------------------------------------------------------------ events */

  /** Registers a handler for an event: 'message', 'callback' (an unmatched button tap) or 'ready'. */
  on(event, handler) {
    if (typeof handler !== 'function') throw new Error('A handler function is required');
    const key = String(event);
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    this.handlers.get(key).push(handler);
    return this;
  }

  /**
   * Registers a command handler.
   *
   * Matches a message that starts with ?name or /name, the same shape DrexBot uses. A message that
   * matches a command is not passed to the generic message handler as well, so a bot does not
   * answer a question twice.
   */
  command(name, handler) {
    if (typeof handler !== 'function') throw new Error('A handler function is required');
    this.commands.set(String(name).replace(/^[?/]/, '').toLowerCase(), handler);
    return this;
  }

  _emit(event, payload) {
    const handlers = this.handlers.get(event) || [];
    for (const handler of handlers) {
      try {
        const result = handler(payload);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => this._log('handler failed', error.message));
        }
      } catch (error) {
        // One bad handler must not stop the others, and must not kill the poll loop.
        this._log('handler failed', error.message);
      }
    }
  }

  _log() {
    if (this.quiet) return;
    console.log('[drexbot]', ...arguments);
  }

  /* ------------------------------------------------------------------ the api */

  /**
   * One HTTP call.
   *
   * Written against http/https rather than fetch so the library runs on old Node versions too,
   * which is the kind of thing that decides whether somebody can use it on their host at all.
   */
  _request(path, options) {
    const opts = options || {};
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const key of Object.keys(opts.query)) {
        if (opts.query[key] !== undefined && opts.query[key] !== null) {
          url.searchParams.set(key, String(opts.query[key]));
        }
      }
    }
    const body = opts.body ? Buffer.from(JSON.stringify(opts.body)) : null;
    const transport = url.protocol === 'http:' ? http : https;
    const headers = {
      Authorization: 'Bearer ' + this.token,
      Accept: 'application/json'
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }

    return new Promise((resolve, reject) => {
      const request = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: opts.method || 'GET',
          headers
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch (error) {
                parsed = null;
              }
            }
            if (response.statusCode >= 200 && response.statusCode < 300) {
              resolve(parsed || {});
              return;
            }
            const error = new Error(
              (parsed && (parsed.message || parsed.error)) || ('Request failed with ' + response.statusCode)
            );
            error.status = response.statusCode;
            error.body = parsed;
            reject(error);
          });
        }
      );

      // A poll is held open by the server on purpose, so the timeout has to allow for that.
      request.setTimeout(opts.timeoutMs || (this.pollTimeout + 15) * 1000, () => {
        request.destroy(new Error('The request timed out'));
      });
      request.on('error', reject);
      if (body) request.write(body);
      request.end();
    });
  }

  /** Who this token belongs to. Also the fastest way to tell whether a token is still valid. */
  getMe() {
    return this._request('/api/bot/me').then((result) => {
      this.me = result.bot || null;
      return this.me;
    });
  }

  /**
   * Sends a message to a chat this bot is in.
   *
   * A bot may only speak where it has been added — the server refuses anything else — so a leaked
   * token cannot be used to message strangers.
   */
  sendMessage(chatId, text, options) {
    if (!chatId) return Promise.reject(new Error('chatId is required'));
    if (text == null || String(text).trim() === '') {
      return Promise.reject(new Error('text is required'));
    }
    const body = { chatId, text: String(text) };
    const buttons = toButtons(options && options.buttons);
    if (buttons) body.buttons = buttons;
    return this._request('/api/bot/send', { method: 'POST', body });
  }

  /**
   * Sends a picture, with an optional caption under it.
   *
   * The address must be http or https — the app draws it as an image, so anything else is refused
   * rather than handed to the WebView. `caption` becomes the message text, so a menu can be one
   * message: the picture with its list of commands.
   */
  sendPhoto(chatId, url, caption, options) {
    return this.sendMedia(chatId, url, 'image', caption, options);
  }

  /** Sends a video the app plays inline. The address must be a direct http(s) link to the file. */
  sendVideo(chatId, url, caption, options) {
    return this.sendMedia(chatId, url, 'video', caption, options);
  }

  /** Sends audio the app plays inline, with a player. */
  sendAudio(chatId, url, caption, options) {
    return this.sendMedia(chatId, url, 'audio', caption, options);
  }

  /**
   * The one place a media message is built; sendPhoto, sendVideo and sendAudio are this with a type.
   *
   * `type` may be 'image', 'video' or 'audio'. Pass null to let the server decide from the file
   * extension. `options.buttons` attaches buttons under the media, the same way as for text.
   */
  sendMedia(chatId, url, type, caption, options) {
    if (!chatId) return Promise.reject(new Error('chatId is required'));
    if (!url || !/^https?:\/\//i.test(String(url))) {
      return Promise.reject(new Error('Media needs an http or https url'));
    }
    const body = {
      chatId,
      text: caption == null ? '' : String(caption),
      mediaUrl: String(url)
    };
    if (type) body.mediaType = String(type);
    const buttons = toButtons(options && options.buttons);
    if (buttons) body.buttons = buttons;
    return this._request('/api/bot/send', { method: 'POST', body });
  }

  /**
   * Registers a handler for a tapped button.
   *
   * `pattern` is the exact `data` of the button, or a RegExp. With a RegExp the match is on
   * ctx.match, so one handler can serve a family: bot.action(/^page:(\d+)$/, ...).
   * A tap that matches nothing here is emitted as a 'callback' event instead.
   */
  action(pattern, handler) {
    if (typeof handler !== 'function') throw new Error('A handler function is required');
    if (typeof pattern !== 'string' && !(pattern instanceof RegExp)) {
      throw new Error('An action needs a string or a RegExp');
    }
    this.actions.push({ pattern, handler });
    return this;
  }

  /* ------------------------------------------------------------------ polling */

  /**
   * Starts the long-poll loop.
   *
   * Resolves only when stop() is called or the token stops working, so `await bot.start()` in a
   * script keeps it alive; most people will call `bot.start()` and leave it running.
   */
  async start() {
    if (this.running) return this;
    this.running = true;

    // Fail fast and loudly on a bad token rather than looping against a 401 forever.
    let me = null;
    try {
      me = await this.getMe();
    } catch (error) {
      this.running = false;
      throw tokenProblem(error) || error;
    }
    this._log('connected as @' + (me && me.username ? me.username : 'unknown'));
    this._emit('ready', me);

    while (this.running) {
      try {
        const result = await this._request('/api/bot/updates', {
          query: { offset: this.offset, timeout: this.pollTimeout }
        });
        if (this._failures) {
          this._log('recovered after ' + this._failures + (this._failures === 1 ? ' failure' : ' failures'));
          this._failures = 0;
          this._lastReason = null;
        }
        this._backoff = BACKOFF_START_MS;
        // Stamped once per batch: every update in it arrived at the same moment.
        const fetchedAt = Date.now();
        const updates = (result && result.updates) || [];
        for (const update of updates) {
          let handled = true;
          try {
            await this._dispatch(update, fetchedAt);
          } catch (error) {
            handled = false;
            this._log('update failed', error.message);
          }
          /*
            The offset is the acknowledgement: moving it tells the server this update is done with.
            It moves only after the handler has run, so a crash part-way through a batch means those
            updates arrive again rather than being lost.
          */
          if (handled && typeof update.update_id === 'number') this.offset = update.update_id;
        }
      } catch (error) {
        if (error.status === 401) {
          // Revoked or replaced. Retrying cannot help, and silently spinning would look like the
          // bot is alive when it is not.
          this.running = false;
          throw tokenProblem(error);
        }
        if (!this.running) break;
        /*
           Logged on the first failure, then every fifth, and whenever the reason changes. An outage
           that lasts an hour otherwise fills the console with the same line and buries everything
           useful, which is the opposite of what logs are for.
        */
        this._failures = (this._failures || 0) + 1;
        const reason = describeFailure(error);
        if (this._failures === 1 || this._failures % 5 === 0 || reason !== this._lastReason) {
          this._log('poll failed: ' + reason
            + ' (' + this._failures + (this._failures === 1 ? ' failure' : ' failures')
            + ', retrying in ' + Math.round(this._backoff / 1000) + 's)');
        }
        this._lastReason = reason;
        await sleep(this._backoff);
        this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX_MS);
      }
    }
    return this;
  }

  /** Asks the loop to stop after the poll in flight returns. */
  stop() {
    this.running = false;
    return this;
  }

  async _dispatch(update, receivedAt) {
    const text = update && update.text != null ? String(update.text) : '';
    const chatId = update && update.chat ? update.chat.id : null;
    const from = (update && update.from) || {};

    const ctx = {
      id: update && update.update_id,
      chatId,
      fromId: from.id != null ? from.id : null,
      fromUsername: from.username || null,
      text,
      messageId: update && update.message_id != null ? update.message_id : null,
      date: (update && update.date) || null,
      bot: this,
      reply: (replyText, options) => this.sendMessage(chatId, replyText, options),
      replyWithPhoto: (url, caption, options) => this.sendPhoto(chatId, url, caption, options),
      replyWithVideo: (url, caption, options) => this.sendVideo(chatId, url, caption, options),
      replyWithAudio: (url, caption, options) => this.sendAudio(chatId, url, caption, options),
      // Set for a button tap; null for an ordinary message.
      data: update && update.type === 'callback' ? String(update.data == null ? '' : update.data) : null,
      isCallback: Boolean(update && update.type === 'callback'),
      match: null,
      // When the server handed this update over. Comparing it with the clock inside a handler shows
      // how long the bot took to get to it, which is the useful half of a ?ping.
      receivedAt
    };

    if (ctx.isCallback) {
      for (const action of this.actions) {
        let match = null;
        if (typeof action.pattern === 'string') {
          if (action.pattern === ctx.data) match = [ctx.data];
        } else {
          match = action.pattern.exec(ctx.data);
        }
        if (!match) continue;
        ctx.match = match;
        try {
          const result = action.handler(ctx);
          if (result && typeof result.catch === 'function') {
            result.catch((error) => this._log('action failed', error.message));
          }
        } catch (error) {
          this._log('action failed', error.message);
        }
        return;
      }
      // Nothing claimed it. Never fall through to the message handler: a tap is not text.
      this._emit('callback', ctx);
      return;
    }

    const name = commandName(text);
    const handler = name ? this.commands.get(name) : null;
    // Published before the handler runs, so a bot can log what it recognised rather than re-parsing
    // the text and disagreeing with the library about it.
    ctx.command = handler ? name : null;
    if (handler) {
      try {
        const result = handler(ctx);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => this._log('command failed', error.message));
        }
      } catch (error) {
        this._log('command failed', error.message);
      }
      return;
    }

    this._emit('message', ctx);
  }
}

/**
 * One line saying what a failed poll means, and whether the bot author can do anything about it.
 *
 * A bot that logs "Request failed with 502" every second tells its author nothing they can act on.
 * A held poll cut off by a proxy, an address with nothing behind it, and a server that has not been
 * updated all produce different messages because they need different fixes.
 */
function describeFailure(error) {
  const status = error && error.status;
  if (status === 502 || status === 503 || status === 504) {
    return 'the server or the proxy in front of it gave up on the request — a poll held open longer '
      + 'than that proxy allows ends this way, so try a smaller pollTimeout';
  }
  if (status === 404) {
    return 'there is no bot API at that address — check baseUrl, and that the backend has been deployed';
  }
  if (status === 401) return 'the token was rejected';
  if (error && error.code === 'ECONNREFUSED') return 'nothing is listening at that address';
  if (error && /timed out/i.test(error.message || '')) return 'the request timed out';
  return (error && error.message) || 'the request failed';
}

/**
 * Turns a rejected token into something a person can act on.
 *
 * A revoked or mistyped token is the most likely thing to go wrong on a first run, and "Invalid bot
 * token" on its own does not tell anyone what to do about it. Returns null for anything else, so
 * the original error is what surfaces.
 */
function tokenProblem(error) {
  if (!error || error.status !== 401) return null;
  return new Error(
    'The bot token was rejected (' + error.message + '). Send ?token to DrexBot in DrexChat for a '
    + 'new one, or ?newbot to create another bot.'
  );
}

/**
 * Buttons in the shape the server takes: rows of { text, data } or { text, url }.
 *
 * Accepts a flat array (one row) or an array of rows, so `[btn('A','a'), btn('B','b')]` and
 * `[[btn('A','a')], [btn('B','b')]]` both do what they look like. Mistakes throw here, in the bot's
 * own stack trace, rather than coming back as a 400 from the server.
 */
function toButtons(input) {
  if (input == null || (Array.isArray(input) && input.length === 0)) return null;
  if (!Array.isArray(input)) throw new Error('buttons must be an array');
  const rows = Array.isArray(input[0]) ? input : [input];
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new Error('every row of buttons must be an array');
    return row.map((item) => {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) {
        throw new Error('a button needs text');
      }
      if (item.url != null) return { text: item.text, url: String(item.url) };
      if (item.data == null || String(item.data) === '') throw new Error('a button needs data or a url');
      return { text: item.text, data: String(item.data) };
    });
  });
}

/** A button that sends `data` back to the bot when tapped. At most 64 bytes of data. */
function button(text, data) {
  return { text: String(text), data: String(data) };
}

/** A button that opens a link instead of calling the bot. */
function urlButton(text, url) {
  return { text: String(text), url: String(url) };
}

function clampPoll(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return DEFAULT_POLL_SECONDS;
  return Math.min(Math.max(Math.floor(value), 0), 50);
}

module.exports = { Bot, commandName, button, urlButton, DEFAULT_BASE_URL };
