/**
 * Invitation codes — the only way an account gets made.
 *
 * The rules this holds to: a registration with no code is refused; a code
 * works exactly once, however fast two people click; a code that fails to
 * produce an account is handed back rather than burned; revoked and expired
 * codes are refused with the reason, not a shrug; and the plain code never
 * reaches the database — only its hash does.
 */
import crypto from 'crypto';
import fs from 'fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`✓ ${label}`);
  else { console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
};

/* ── the database, as far as any of this is concerned ── */
const db = { invites: [], users: [] };
/* Every statement the stub was asked to run, so a test can assert on what did
   and did not travel to the server. */
const seen = [];

globalThis.__db = (text, params) => {
  const q = text.replace(/\s+/g, ' ').trim();
  seen.push({ q, params });
  const now = new Date();

  if (q.startsWith('insert into invite_codes')) {
    const [id, code_hash, prefix, created_by, days] = params;
    const row = {
      id, code_hash, prefix, created_by,
      created_at: now,
      expires_at: new Date(now.getTime() + days * 86400000),
      revoked_at: null, used_at: null, used_by: null,
    };
    db.invites.push(row);
    return [row];
  }
  if (q.startsWith('select i.id, i.prefix')) {
    /* Projects exactly the columns the statement names — including leaving
       out code_hash, which is the thing worth checking. */
    return db.invites.map(i => ({
      id: i.id, prefix: i.prefix, created_at: i.created_at, expires_at: i.expires_at,
      revoked_at: i.revoked_at, used_at: i.used_at,
      used_by_username: (db.users.find(u => u.id === i.used_by) || {}).username || null,
      created_by_username: null,
    }));
  }
  if (q.startsWith('update invite_codes set revoked_at')) {
    const row = db.invites.find(i => i.id === params[0] && !i.used_at && !i.revoked_at);
    if (!row) return [];
    row.revoked_at = now;
    return [{ id: row.id }];
  }
  if (q.startsWith('select id, expires_at, revoked_at, used_at from invite_codes')) {
    return db.invites.filter(i => i.code_hash === params[0])
      .map(i => ({ id: i.id, expires_at: i.expires_at, revoked_at: i.revoked_at, used_at: i.used_at }));
  }
  if (q.startsWith('update invite_codes set used_at = now()')) {
    /* The whole point: one row changes, or none do. */
    const row = db.invites.find(i =>
      i.code_hash === params[0] && !i.used_at && !i.revoked_at && i.expires_at > now);
    if (!row) return [];
    row.used_at = now;
    return [{ id: row.id }];
  }
  if (q.startsWith('update invite_codes set used_at = null')) {
    const row = db.invites.find(i => i.id === params[0]);
    if (row) { row.used_at = null; row.used_by = null; }
    return [];
  }
  if (q.startsWith('update invite_codes set used_by')) {
    const row = db.invites.find(i => i.id === params[1]);
    if (row) row.used_by = params[0];
    return [];
  }

  if (q.startsWith('select id from users where username')) {
    return db.users.filter(u => u.username === params[0]).map(u => ({ id: u.id }));
  }
  if (q.startsWith('insert into users')) {
    const [id, username] = params;
    if (db.users.some(u => u.username === username)) {
      throw new Error('duplicate key value violates unique constraint "users_username_key"');
    }
    db.users.push({ id, username });
    return [];
  }

  return [];   // seeding the starter chatbots, and anything else incidental
};

const {
  generateCode, normalizeCode, looksLikeCode, hashCode, formatCode,
  createInvite, claimInvite, checkInvite, revokeInvite, listInvites, ALPHABET,
} = await import(`${ROOT}/api/_invites.js`);

/* ─────────────── the code itself ─────────────── */

const code = generateCode();
ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), 'a code is three groups of four', code);
ok([...normalizeCode(code)].every(c => ALPHABET.includes(c)), 'every character is in the alphabet', code);
ok(!/[01ILO]/.test(code), 'no 0/1/I/L/O — it gets read out over the phone', code);

const many = Array.from({ length: 400 }, generateCode);
ok(new Set(many).size === 400, 'four hundred codes, four hundred different codes');
ok(!many.some(c => /[01ILO]/.test(c)), 'and not one of them slipped a lookalike in');

ok(normalizeCode('7qf4 2mkd-8rtv ') === '7QF42MKD8RTV', 'lower case, stray spaces and a dash all wash out');
ok(normalizeCode('7QF-42M-KD8-RTV') === '7QF42MKD8RTV', 'dashes in the wrong places are still the same code');
ok(looksLikeCode('7qf4-2mkd-8rtv'), 'a well-formed code is worth a round trip');
ok(!looksLikeCode('7QF4-2MKD'), 'a short one is not');
ok(!looksLikeCode('7QF4-2MKD-8RT0'), 'nor is one carrying a character we never mint');
ok(formatCode('7QF42MKD8RTV') === '7QF4-2MKD-8RTV', 'formatting groups it back');

/* ─────────────── what reaches the database ─────────────── */

seen.length = 0;
const made = await createInvite('admin-1');
const insert = seen.find(s => s.q.startsWith('insert into invite_codes'));
ok(!!insert, 'minting writes a row');
ok(!insert.params.includes(normalizeCode(made.code)),
   'the plain code is not one of the values written');
ok(insert.params.includes(hashCode(made.code)), 'its hash is');
ok(insert.params.includes(normalizeCode(made.code).slice(0, 4)),
   'and the first four characters, so the row can be recognised');
ok(made.code.length === 14, 'the caller gets the readable code back, this once');

/* ─────────────── one code, one account ─────────────── */

const registerMod = await import(`${ROOT}/api/auth/register.js`);
const register = registerMod.default;

function call(body) {
  const res = {
    code: 0, body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  return register({ method: 'POST', body }, res).then(() => res);
}

let r = await call({ username: 'dana', password: 'pw', phone: '050' });
ok(r.code === 403, 'no code, no account', `got ${r.code}`);
ok(db.users.length === 0, 'and nothing was written');

r = await call({ username: 'dana', password: 'pw', phone: '050', inviteCode: 'ZZZZ-ZZZZ-ZZZZ' });
ok(r.code === 403, 'a code that was never minted is refused', `got ${r.code}`);

r = await call({ username: 'dana', password: 'pw', phone: '050', inviteCode: made.code.toLowerCase() });
ok(r.code === 201, 'the real code, typed in lower case, opens an account', `got ${r.code} ${JSON.stringify(r.body)}`);
ok(!!r.body.token, 'and hands back a session');
ok(db.invites[0].used_by === db.users[0].id, 'the code records who spent it');

r = await call({ username: 'noa', password: 'pw', phone: '051', inviteCode: made.code });
ok(r.code === 403, 'the same code cannot be spent twice', `got ${r.code}`);
ok(/already been used/i.test(r.body.error), 'and says which of the four reasons it is', r.body.error);
ok(db.users.length === 1, 'still one account');

/* ─────────────── a failed registration hands the code back ─────────────── */

const second = await createInvite('admin-1');
r = await call({ username: 'dana', password: 'pw', phone: '052', inviteCode: second.code });
ok(r.code === 409, 'a name already taken is refused', `got ${r.code}`);
const stillOpen = await checkInvite(second.code);
ok(stillOpen.ok, 'and the code it came with is still good — a taken username must not cost somebody their invitation');

r = await call({ username: 'noa', password: 'pw', phone: '052', inviteCode: second.code });
ok(r.code === 201, 'so the second attempt gets in on it', `got ${r.code}`);

/* ─────────────── revoked, and expired ─────────────── */

const third = await createInvite('admin-1');
ok(await revokeInvite(third.invite.id), 'an open code can be cancelled');
let check = await checkInvite(third.code);
ok(!check.ok && /cancelled/i.test(check.reason), 'a cancelled code says so', check.reason);
ok(!(await revokeInvite(third.invite.id)), 'cancelling it twice does nothing');

const fourth = await createInvite('admin-1', 14);
db.invites.find(i => i.id === fourth.invite.id).expires_at = new Date(Date.now() - 1000);
check = await checkInvite(fourth.code);
ok(!check.ok && /expired/i.test(check.reason), 'an expired code says so', check.reason);
r = await call({ username: 'yoni', password: 'pw', phone: '053', inviteCode: fourth.code });
ok(r.code === 403, 'and cannot be claimed either', `got ${r.code}`);

/* ─────────────── two people, one code, at the same instant ─────────────── */

const shared = await createInvite('admin-1');
const race = await Promise.all([
  call({ username: 'racer-a', password: 'pw', phone: '054', inviteCode: shared.code }),
  call({ username: 'racer-b', password: 'pw', phone: '055', inviteCode: shared.code }),
]);
ok(race.filter(x => x.code === 201).length === 1, 'exactly one of two racers gets in',
   race.map(x => x.code).join('/'));
ok(race.filter(x => x.code === 403).length === 1, 'and the other is told the code is gone');

/* ─────────────── the list shows what became of each, not what each is ─────────────── */

const listed = await listInvites();
ok(listed.length === db.invites.length, 'the list covers every code ever minted');
ok(listed.every(row => !('code_hash' in row)), 'and hands back no hash to work on offline');
const { inviteState } = await import(`${ROOT}/api/_invites.js`);
const states = db.invites.map(i => inviteState(i));
ok(states.includes('used') && states.includes('revoked') && states.includes('expired'),
   'used, revoked and expired are all distinguishable', states.join(','));

/* ─────────────── the front door ─────────────── */

const html = fs.readFileSync(`${ROOT}/agentforge.html`, 'utf8');
const gate = html.slice(html.indexOf('function LoginGate'), html.indexOf('ADMIN: INVITATIONS'));
ok(!/\['login', 'register'\]\.map/.test(gate), 'the sign-in / register toggle is gone');
ok(gate.includes("inviteCode: accepted"), 'registration carries the code that opened it');
ok(/mode === 'code'/.test(gate), 'and there is a screen to type one into');
ok(gate.includes('/api/auth/invite-check'), 'which asks the server before showing a form');
ok(gate.includes('href="/privacy"') && gate.includes('href="/terms"'),
   'the front door links the two pages Google\'s review looks for');

/* The check is a courtesy; the server is the gate. If the browser could reach
   register without a code the screen would be decoration. */
const registerSrc = fs.readFileSync(`${ROOT}/api/auth/register.js`, 'utf8');
ok(/if \(!inviteCode\)/.test(registerSrc), 'the server refuses a registration with no code');
ok(registerSrc.indexOf('claimInvite') < registerSrc.indexOf('insert into users'),
   'and claims it before it writes an account');

/* ─────────────── the language question moved off the browser ─────────────── */

ok(/settings\.languageChosen === false/.test(html),
   'the language screen is shown from the account, not from localStorage');
ok(!/setTour\('language'\)/.test(html), 'and is no longer a step of the tour');
const langEffect = html.slice(html.indexOf('const [askLanguage'), html.indexOf('const [tour, setTour]'));
ok(!/isMobile/.test(langEffect), 'a phone is asked too — it is a screen, not a spotlight');

console.log(failed ? `\n${failed} failed` : '\nall good');
process.exit(failed ? 1 : 0);
