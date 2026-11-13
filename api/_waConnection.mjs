import { EventEmitter } from 'node:events';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
} from 'baileys';
import { clearAuth, usePostgresAuthState } from './_waAuth.mjs';

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'info' });

/**
 * One linked-device connection to WhatsApp for one number (like WhatsApp Web).
 *
 * Ported from the Grois group bot, narrowed to what a number in 8Legs does:
 * one-to-one chats. Groups, status updates and channels are ignored.
 *
 * Emits 'state' when the connection state changes and 'message' for every
 * parsed one-to-one message. `fatal` is set when the session must end (another
 * connection replaced this one).
 */
export class WhatsApp extends EventEmitter {
  sock = null;
  state = { status: 'starting', qr: null, me: null, error: null };
  fatal = null;
  #auth = null;
  #stopping = false;

  constructor({ numberId }) {
    super();
    this.numberId = numberId;
    this.log = logger.child({ module: 'wa', numberId });
  }

  async start() {
    this.#stopping = false;
    await this.#auth?.flush(); // a reconnect must read the keys the previous socket wrote
    this.#auth = await usePostgresAuthState(this.numberId);
    const { state, saveCreds } = this.#auth;
    const baileysLogger = logger.child({ module: 'baileys' }, { level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      this.log.warn({ err: err.message }, 'could not fetch the latest WA version, using the bundled one');
    }

    const sock = makeWASocket({
      ...(version && { version }),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      browser: ['8Legs', 'Chrome', '1.0'],
      markOnlineOnConnect: false, // keep the phone's own notifications working
      syncFullHistory: false,
    });
    this.sock = sock;
    this.#setState({ status: 'connecting', qr: null, error: null });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        this.#setState({ status: 'qr', qr: dataUrl });
      }
      if (connection === 'open') {
        const me = {
          id: jidNormalizedUser(sock.user.id),
          lid: sock.user.lid ? jidNormalizedUser(sock.user.lid) : null,
          name: sock.user.name || sock.user.notify || null,
        };
        this.#setState({ status: 'open', qr: null, me, error: null });
        this.log.info({ me }, 'connected');
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (this.#stopping) return;
        if (code === DisconnectReason.connectionReplaced) {
          this.log.warn('another connection replaced this one — ending the session');
          this.fatal = 'replaced';
          return;
        }
        if (code === DisconnectReason.loggedOut) {
          this.log.warn('logged out from the phone — clearing the session, a new QR will be needed');
          this.#setState({ status: 'logged_out', me: null, error: 'The phone unlinked this device' });
          await clearAuth(this.numberId);
          this.fatal = 'logout';
          return;
        }
        this.log.warn({ code, err: lastDisconnect?.error?.message }, 'connection closed, reconnecting');
        this.#setState({ status: 'connecting', error: lastDisconnect?.error?.message || null });
        setTimeout(() => {
          if (!this.#stopping) this.start().catch((err) => this.log.error(err, 'restart failed'));
        }, 2000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const raw of messages) {
        this.#parse(raw)
          .then((msg) => msg && this.emit('message', { ...msg, live: type === 'notify' }))
          .catch((err) => this.log.warn({ err: err.message }, 'could not read a message'));
      }
    });
  }

  /** Closes the socket and waits until the keys are saved, so the next session can resume. */
  async stop() {
    this.#stopping = true;
    this.sock?.end(undefined);
    await this.#auth?.flush();
  }

  /** Unlinks this device from the phone and forgets its keys. */
  async logout() {
    this.#stopping = true;
    try {
      await this.sock?.logout();
    } catch {
      this.sock?.end(undefined);
    }
    await this.#auth?.flush();
    await clearAuth(this.numberId);
    this.#setState({ status: 'logged_out', me: null, qr: null });
  }

  get linked() {
    return !!this.sock?.authState?.creds?.me;
  }

  /** Sends text, split to WhatsApp's length limit. Returns the id of the last message sent. */
  async sendText(jid, text) {
    let id = null;
    for (const chunk of splitMessage(text)) {
      const sent = await this.sock.sendMessage(jid, { text: chunk });
      id = sent?.key?.id || id;
    }
    return id;
  }

  async setTyping(jid, on) {
    try {
      await this.sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
    } catch {
      // presence is cosmetic
    }
  }

  async markRead(raw) {
    try {
      await this.sock.readMessages([raw.key]);
    } catch {
      // read receipts are cosmetic
    }
  }

  /** The bytes of an image, voice note or document, for the capabilities that read them. */
  async downloadMedia(raw) {
    return downloadMediaMessage(raw, 'buffer', {}, { logger: this.log, reuploadRequest: this.sock.updateMediaMessage });
  }

  #setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** The sender's phone number, digits only, even when WhatsApp addresses them by a LID. */
  async #phoneOf(key) {
    for (const jid of [key.remoteJid, key.remoteJidAlt, key.senderPn]) {
      if (jid && isPnUser(jid)) return userOf(jid);
    }
    const lid = [key.remoteJid, key.remoteJidAlt].find((j) => j && isLidUser(j));
    if (lid) {
      try {
        const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(lid);
        if (pn) return userOf(pn);
      } catch {
        // fall through: unknown sender
      }
    }
    return null;
  }

  async #parse(raw) {
    const key = raw.key;
    const chatJid = key?.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast' || chatJid.endsWith('@newsletter') || chatJid.endsWith('@broadcast')) return null;
    if (isJidGroup(chatJid)) return null;

    const content = normalizeMessageContent(raw.message);
    if (!content) return null;
    const type = getContentType(content);
    const body = content[type];
    const { text, kind } = describe(type, body);
    if (text == null) return null;

    return {
      chatJid,
      waId: key.id,
      fromMe: !!key.fromMe,
      senderPhone: key.fromMe ? null : await this.#phoneOf(key),
      senderName: key.fromMe ? null : raw.pushName || null,
      text,
      kind,
      raw,
      ts: Number(raw.messageTimestamp || 0) * 1000 || Date.now(),
    };
  }
}

const userOf = (jid) => jid.split('@')[0].split(':')[0];

function splitMessage(text, maxLen = 4000) {
  const chunks = [];
  let rest = String(text || '');
  while (rest.length > maxLen) {
    let at = rest.lastIndexOf('\n', maxLen);
    if (at < maxLen * 0.5) at = rest.lastIndexOf(' ', maxLen);
    if (at < maxLen * 0.5) at = maxLen;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** What a message says, in words the model can read, and what kind of thing it is. */
function describe(type, body) {
  const caption = body?.caption ? ` ${body.caption}` : '';
  switch (type) {
    case 'conversation':
      return { text: body, kind: 'text' };
    case 'extendedTextMessage':
      return { text: body.text || '', kind: 'text' };
    case 'imageMessage':
      return { text: `[image]${caption}`, kind: 'image' };
    case 'videoMessage':
      return { text: `[video]${caption}`, kind: 'video' };
    case 'audioMessage':
      return { text: body.ptt ? '[voice message]' : '[audio file]', kind: 'audio' };
    case 'stickerMessage':
      return { text: '[sticker]', kind: 'sticker' };
    case 'documentMessage':
      return { text: `[file: ${body.fileName || 'untitled'}]${caption}`, kind: 'document' };
    case 'documentWithCaptionMessage':
      return describe('documentMessage', body.message?.documentMessage);
    case 'locationMessage':
    case 'liveLocationMessage':
      return { text: `[location${body.name ? ': ' + body.name : ''}]`, kind: 'location' };
    case 'contactMessage':
      return { text: `[contact: ${body.displayName || ''}]`, kind: 'contact' };
    default:
      return { text: null, kind: null }; // reactions, protocol messages, edits
  }
}
