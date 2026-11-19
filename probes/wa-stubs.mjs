/**
 * Stand-ins for wa-reconnect-probe, mapped in by wa-loader.mjs:
 *
 * - baileys: a socket the probe drives by emitting connection updates on it.
 * - @vercel/functions: waitUntil keeps the promise, so the probe can wait on it.
 * - for the worker session only: a WhatsApp connection that opens at once and
 *   counts how many are open per number, and a router with nothing to do.
 *
 * Everything the probe looks at lives on globalThis.__wa.
 */
import { EventEmitter } from 'node:events';

const probe = (globalThis.__wa ||= {});
probe.sockets ||= [];          // every Baileys socket made, in order
probe.connections ||= [];      // every session connection made, in order
probe.live ||= new Map();      // number id -> session connections open now
probe.maxLive ||= new Map();   // number id -> the most ever open at once
probe.background ||= [];       // promises handed to waitUntil

/* ── baileys ─────────────────────────────────────────────────────────────── */

export const DisconnectReason = { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, loggedOut: 401, restartRequired: 515 };
export const BufferJSON = { replacer: (k, v) => v, reviver: (k, v) => v };
export const initAuthCreds = () => ({});
export const proto = { Message: { AppStateSyncKeyData: { fromObject: (o) => o } } };
export const fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 0] });
export const makeCacheableSignalKeyStore = (keys) => keys;
export const jidNormalizedUser = (jid) => String(jid).replace(/:\d+@/, '@');
export const isJidGroup = (jid) => !!jid?.endsWith('@g.us');
export const isLidUser = (jid) => !!jid?.endsWith('@lid');
export const isPnUser = (jid) => !!jid?.endsWith('@s.whatsapp.net');
export const getContentType = (m) => Object.keys(m || {})[0];
export const normalizeMessageContent = (m) => m;
export const downloadMediaMessage = async () => Buffer.alloc(0);

export default function makeWASocket({ auth }) {
  const sock = {
    ev: new EventEmitter(),
    authState: { creds: auth.creds },
    user: { id: '972500000001:7@s.whatsapp.net', name: 'Probe' },
    ended: false,
    end() { this.ended = true; },
    async logout() { this.ended = true; },
    async groupFetchAllParticipating() { return {}; },
  };
  probe.sockets.push(sock);
  return sock;
}

/* ── @vercel/functions ───────────────────────────────────────────────────── */

export function waitUntil(promise) {
  probe.background.push(promise);
}

/* ── the worker session's connection and router ──────────────────────────── */

export class WhatsApp extends EventEmitter {
  state = { status: 'starting', qr: null, me: null, error: null };
  stopped = false;
  crash = false; // probe: the session's next look at the connection throws
  #fatal = null;

  constructor({ numberId }) {
    super();
    this.numberId = numberId;
  }

  get fatal() {
    if (this.crash) throw new Error('probe: the session crashed');
    return this.#fatal;
  }

  set fatal(reason) {
    this.#fatal = reason;
  }

  get linked() {
    return probe.isLinked(this.numberId);
  }

  async start() {
    const open = (probe.live.get(this.numberId) || 0) + 1;
    probe.live.set(this.numberId, open);
    probe.maxLive.set(this.numberId, Math.max(open, probe.maxLive.get(this.numberId) || 0));
    probe.connections.push(this);
    this.#set({ status: 'connecting' });
    this.#set({ status: 'open', me: { id: '972500000001@s.whatsapp.net', lid: null, name: 'Probe' }, error: null });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    probe.live.set(this.numberId, probe.live.get(this.numberId) - 1);
  }

  async logout() {
    probe.unlink(this.numberId);
    this.#set({ status: 'logged_out', me: null, qr: null });
    await this.stop();
  }

  /** probe: the phone unlinked this device (what Baileys reports as loggedOut). */
  phoneUnlinked() {
    probe.unlink(this.numberId);
    this.#set({ status: 'logged_out', me: null, error: 'The phone unlinked this device' });
    this.fatal = 'logout';
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }
}

export function createRouter() {
  return { drain: async () => {}, sendDueReminders: async () => {}, sendOutbox: async () => 0, runDue: async () => {} };
}
