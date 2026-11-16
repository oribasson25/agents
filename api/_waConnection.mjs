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
 * Ported from the Grois group bot: one-to-one chats, and the groups the number
 * is a member of. Status updates and channels are ignored.
 *
 * Emits 'state' when the connection state changes, 'message' for every parsed
 * message (`isGroup` tells which kind), and 'groups' with { jid, name } of
 * groups the number is in, and 'joined' when people are added to one. `fatal` is set when the session must end (another
 * connection replaced this one).
 */
export class WhatsApp extends EventEmitter {
  sock = null;
  state = { status: 'starting', qr: null, me: null, error: null };
  fatal = null;
  names = new Map();      // user id (no device / server) -> display name seen in a group
  groupCache = new Map(); // group jid -> metadata, which Baileys reuses when sending to a group
  #auth = null;
  #stopping = false;

  /** @param {{ numberId: string, selfName?: () => string }} opts  selfName: how the number is shown when someone tags it */
  constructor({ numberId, selfName = () => null }) {
    super();
    this.numberId = numberId;
    this.selfName = selfName;
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
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
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
        this.refreshGroups().catch((err) => this.log.warn({ err: err.message }, 'could not list groups'));
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

    sock.ev.on('groups.upsert', (groups) => {
      for (const g of groups) this.groupCache.set(g.id, g);
      this.emit('groups', groups.map((g) => ({ jid: g.id, name: g.subject || null })));
    });
    sock.ev.on('groups.update', (updates) => updates.forEach((u) => u.id && this.refreshGroup(u.id)));
    sock.ev.on('group-participants.update', (ev) => {
      if (!ev?.id) return;
      this.refreshGroup(ev.id);
      // Who joined, for the group's welcome message. Entries are jids, or { id, phoneNumber } on newer Baileys.
      if (ev.action === 'add') {
        const joined = (ev.participants || []).map((p) => (typeof p === 'string' ? { jid: p } : { jid: p.id, pn: p.phoneNumber || null }))
          .filter((p) => p.jid && !this.isMe(p.jid) && !(p.pn && this.isMe(p.pn)));
        if (joined.length) this.emit('joined', { chatJid: ev.id, joined });
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

  /**
   * Sends text, split to WhatsApp's length limit. `quotedRow` (a stored group
   * message) makes the first part a reply to it; `mentions` are the jids the
   * text tags (each written in it as "@<number>", or all of them for
   * "@everyone"). Returns the id of the last message sent.
   */
  async sendText(jid, text, quotedRow = null, mentions = []) {
    let id = null;
    let quoted = quotedRow ? toWAMessage(jid, quotedRow) : null;
    for (const chunk of splitMessage(text)) {
      const sent = await this.sock.sendMessage(jid, { text: chunk, ...(mentions.length && { mentions }) }, quoted ? { quoted } : undefined);
      id = sent?.key?.id || id;
      quoted = null;
    }
    return id;
  }

  /** Sends a WhatsApp poll; `multi` lets people choose several answers. */
  async sendPoll(jid, question, options, multi = false) {
    const sent = await this.sock.sendMessage(jid, { poll: { name: question, values: options, selectableCount: multi ? options.length : 1 } });
    return sent?.key?.id || null;
  }

  /** The members of a group: [{ jid, phone, name }]. `jid` is how WhatsApp addresses them there. */
  async groupMembers(jid) {
    let meta = this.groupCache.get(jid);
    if (!meta?.participants) {
      await this.refreshGroup(jid);
      meta = this.groupCache.get(jid);
    }
    return (meta?.participants || []).filter((p) => !this.isMe(p.id) && !this.isMe(p.phoneNumber || p.lid || '')).map((p) => {
      const pn = [p.phoneNumber, p.id, p.jid].find((j) => j && isPnUser(j));
      return { jid: p.id, phone: pn ? userOf(pn) : null, name: this.names.get(userOf(p.id)) || (pn && this.names.get(userOf(pn))) || null };
    });
  }

  /** Reacts to a stored group message with one emoji. */
  async react(jid, row, emoji) {
    await this.sock.sendMessage(jid, { react: { text: emoji, key: toWAMessage(jid, row).key } });
  }

  /** Every group the number is in, with names; also emitted as 'groups'. */
  async refreshGroups() {
    const all = await this.sock.groupFetchAllParticipating();
    for (const g of Object.values(all)) this.groupCache.set(g.id, g);
    const groups = Object.values(all).map((g) => ({ jid: g.id, name: g.subject || null }));
    this.emit('groups', groups);
    return groups;
  }

  async refreshGroup(jid) {
    try {
      const meta = await this.sock.groupMetadata(jid);
      this.groupCache.set(jid, meta);
      this.emit('groups', [{ jid, name: meta.subject || null }]);
    } catch (err) {
      this.log.debug({ jid, err: err.message }, 'group metadata failed');
    }
  }

  /** Whether a jid is this number, by phone or by LID. */
  isMe(jid) {
    if (!jid || !this.state.me) return false;
    const user = userOf(jid);
    return user === userOf(this.state.me.id) || (!!this.state.me.lid && user === userOf(this.state.me.lid));
  }

  nameOf(jid) {
    if (!jid || this.isMe(jid)) return null;
    return this.names.get(userOf(jid)) || null;
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

  /**
   * The sender's phone number, digits only, even when WhatsApp addresses them
   * by a LID. In a group the sender is the participant, not the chat.
   */
  async #phoneOf(key) {
    const candidates = isJidGroup(key.remoteJid)
      ? [key.participant, key.participantAlt, key.participantPn]
      : [key.remoteJid, key.remoteJidAlt, key.senderPn];
    for (const jid of candidates) {
      if (jid && isPnUser(jid)) return userOf(jid);
    }
    const lid = candidates.find((j) => j && isLidUser(j));
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

    const content = normalizeMessageContent(raw.message);
    if (!content) return null;
    const type = getContentType(content);
    const body = content[type];
    const { text, kind } = describe(type, body);
    if (text == null) return null;

    const base = {
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
    if (!isJidGroup(chatJid)) return { ...base, isGroup: false };

    // Groups: who wrote it, who it tags, and whether it answers this number.
    const senderJid = key.fromMe ? this.state.me?.id || null : key.participant || null;
    if (raw.pushName && !key.fromMe) {
      for (const jid of [key.participant, key.participantAlt, key.participantPn]) {
        if (jid) this.names.set(userOf(jid), raw.pushName);
      }
    }
    const ctx = body?.contextInfo || body?.message?.documentMessage?.contextInfo || null;
    const quoted = ctx?.quotedMessage ? normalizeMessageContent(ctx.quotedMessage) : null;
    const quotedType = quoted ? getContentType(quoted) : null;
    const mentioned = (ctx?.mentionedJid || []).filter(Boolean);
    return {
      ...base,
      isGroup: true,
      senderJid,
      senderName: key.fromMe ? null : raw.pushName || this.nameOf(senderJid),
      text: this.#readableMentions(text, mentioned),
      quotedWaId: ctx?.stanzaId || null,
      quotedText: quotedType ? describe(quotedType, quoted[quotedType]).text : null,
      mentionsMe: mentioned.some((j) => this.isMe(j)),
      repliesToMe: !!ctx?.participant && this.isMe(ctx.participant),
    };
  }

  /** "@972501234567" / "@123456789012345" → "@Name", so the model sees who was tagged. */
  #readableMentions(text, mentioned) {
    let out = text;
    for (const jid of mentioned) {
      const name = this.isMe(jid) ? this.selfName() : this.nameOf(jid);
      if (name) out = out.replaceAll(`@${userOf(jid)}`, `@${name}`);
    }
    return out;
  }
}

/** A stored group message in the shape Baileys needs to quote or react to it. */
function toWAMessage(chatJid, row) {
  return {
    key: {
      remoteJid: chatJid,
      id: row.wa_id,
      fromMe: !!row.from_me,
      ...(isJidGroup(chatJid) && row.sender_jid && !row.from_me && { participant: row.sender_jid }),
    },
    message: { conversation: row.text },
  };
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
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { text: `[poll: ${body.name} | ${(body.options || []).map((o) => o.optionName).join(' / ')}]`, kind: 'poll' };
    default:
      return { text: null, kind: null }; // reactions, protocol messages, edits
  }
}
