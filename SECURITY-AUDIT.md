# 8Legs.ai — Security Audit

**Date:** 21 September 2026
**Scope:** every `/api` endpoint, authentication, ownership checks, the tool sandbox, and everything reachable from the public internet.
**Method:** source review of the whole `api/` tree plus live probing of production (`www.8legs.world`). Every live test was read-only or a benign proof — nothing on the server was changed, and no secret was exfiltrated.
**Nothing in the codebase was modified.** This is a report; fixes are proposed, not applied.

Findings are ordered by severity. Each has: what it is, proof, the blast radius, and the fix.

---

## CRITICAL

### C1 — Unauthenticated remote code execution (`/api/run-tool`)

`api/run_tool.py` accepts a JSON body with `code`, `packages` and `env_vars`, and runs the code with `exec()` — installing pip packages and setting environment variables first. It has **no authentication**, and `Access-Control-Allow-Origin: *`. Anyone on the internet can run arbitrary Python on the server.

**Proof (run against production, harmless payload):**
```
POST https://www.8legs.world/api/run-tool
{"code":"import sys, platform\ndef run(**k): return f'6*7={6*7}, python={sys.version.split()[0]}, host={platform.node()}'","inputs":{}}

→ {"result": "proof: 6*7=42, python=3.12.14, host=169.254.53.235"}
```

**Blast radius — this is the whole system.** Code run here can:
- read `os.environ`, which on Vercel holds **`DATABASE_URL`, `JWT_SECRET`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`** and every other platform secret;
- with `DATABASE_URL`, read and write the entire database — every user, every chatbot, every stored API key, every Gmail token, every conversation, and the invitation codes;
- with `JWT_SECRET`, forge a login token for **any user, including an admin** (see C2) — no password needed;
- make outbound HTTPS, so all of the above can be exfiltrated to an attacker's server in one request;
- `pip install` arbitrary packages.

Every other secret and every other check in the system is downstream of this one endpoint. It is the first and only thing that has to be fixed before the app is exposed to the public.

**Fix:**
- The endpoint must never be reachable from a browser or the public internet. It is called server-to-server by the agent runner (`api/_agentRunner.js` → `fetch('${baseUrl}/api/run-tool')`). Put it behind a shared secret: generate `INTERNAL_TOOL_SECRET`, have `_agentRunner.js` send it as a header, and have `run_tool.py` reject any request without it. Remove `Access-Control-Allow-Origin: *` — nothing in a browser should call it.
- Longer term, `exec()` of caller-supplied code in the same process as the platform's secrets is the wrong shape even with the secret. The environment variables a tool needs are the only ones that should exist in that process; `os.environ` should not carry `DATABASE_URL` or `JWT_SECRET` into it. Run tools in a separate function/deployment whose environment holds nothing but what the tool declared.
- The same shared-secret treatment applies to the other internal endpoints below.

---

### C2 — `JWT_SECRET` falls back to a hard-coded value

`api/_auth.js`, `api/gmail/auth.js` and `api/gmail/callback.js` all do:
```js
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
```

If `JWT_SECRET` is ever unset in the environment, every session token is signed with a string that is public in this repo. Anyone can then forge a token for any user — including `isAdmin: true` — and the server accepts it.

On its own this is only a risk if the env var is missing. **Chained with C1 it is worse:** C1 reads the *real* `JWT_SECRET` out of the environment, and then this same forging is possible regardless. Either way the token-signing key must be strong and never have a fallback.

**Fix:** remove the `|| 'change-me-in-production'` fallback in all three files and fail loudly at startup if `JWT_SECRET` is unset. Confirm it is set in Vercel (it appears to be — production tokens verify — but the fallback must go so a future misconfiguration cannot silently open the door). Rotate the secret after C1 is closed, since C1 means it must be assumed leaked; note that rotating it signs everyone out, which is the correct outcome.

---

## HIGH

### H1 — Server-side request forgery (`/api/scrape`, `/api/scrape-browser`, `/api/ollama-proxy`)

All three are unauthenticated, CORS `*`, and fetch a URL taken straight from the request with no allow-list.

- `api/scrape.py` and `api/scrape_browser.js` fetch any `url` and return the body.
- `api/ollama-proxy.js` POSTs to `${host}${path}` from the body — an arbitrary host and path, with an arbitrary JSON body.

**Confirmed reachable in production** (all return CORS headers to `Origin: https://evil.example`).

**Blast radius:** an attacker uses the server as a proxy to reach things it can reach and they cannot — a cloud metadata endpoint (`http://169.254.169.254/…`, and the host in the C1 proof is a `169.254.x.x` link-local address, so a metadata service is plausibly in range), internal services, or another site that then sees 8legs' IP rather than the attacker's. `scrape` returns the fetched body directly, so it doubles as a read oracle.

**Fix:** put these behind the same internal shared secret as C1 (the agent runner is the only legitimate caller of `scrape-browser` and `ollama-proxy`). For anything that must stay callable, block requests to private, loopback and link-local ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`) after resolving the host, and drop `Access-Control-Allow-Origin: *`.

### H2 — The account API key is served to the browser

`api/settings.js` GET returns `apiKey: settings.api_key` in the response body. The Anthropic/OpenAI key is delivered to the client on every settings load.

This is a deliberate choice noted in the code (the browser used to make model calls directly), but the model calls now run server-side in `_agentRunner.js`. The key no longer needs to reach the browser, and every place it does is one more place it can leak — a browser extension, a shared screen, a cached response, an XSS.

**Fix:** stop returning the raw key. Return a boolean `hasKey` and a masked preview (`sk-…last4`) for display. The server already has the key for its own calls; the browser does not need it. This is a moderate refactor — check no client path still reads `settings.apiKey` for a live call before removing it.

### H3 — No rate limiting on login or the widget

- `api/auth/login.js` has no attempt limiting — passwords can be brute-forced at full speed. `scryptSync` is slow, which helps, but does not replace a lockout.
- `api/widget/[agentId]/chat.js` is public by design and has no rate limit. Every message bills the **owner's** API key. A script pointed at a known `agentId` can run up an unbounded bill, and `agentId`s appear in embed code on customers' public sites.

**Fix:** add per-IP (and per-username) throttling to login — a small in-DB counter with a cooldown is enough. For the widget, add a per-session and per-IP message cap, and consider a monthly per-agent ceiling so a runaway cannot bill without limit.

---

## MEDIUM

### M1 — JWT passed in the URL query string (`/api/gmail/auth`)

`api/gmail/auth.js` reads the session token from `req.query.token` because it is a browser redirect that cannot set a header. Query strings land in server access logs, proxy logs, and the browser's history, and leak via `Referer` to Google on the redirect. A leaked token is a full session until it expires (7 days).

**Fix:** hand the OAuth flow a short-lived, single-use state token minted for exactly this purpose instead of the full session JWT — mint it from an authenticated POST, store its hash server-side with a 5-minute TTL, and put only that opaque handle in the URL. It already signs a `state` value; the entry token should get the same treatment.

### M2 — Username enumeration on registration

`api/auth/register.js` returns `"Username already taken"` (409) before the invitation code is checked in one path and distinctly from other errors, so an attacker with a valid code — or just probing — can tell which usernames exist. Login correctly returns a single generic message; registration does not. Low impact on its own (accounts are invite-only), worth tightening.

**Fix:** keep the username-taken message (it is genuinely useful to a real user) but rate-limit registration attempts per IP so it cannot be used to enumerate at scale.

### M3 — Tool secrets are readable by anyone who can edit the tool

Documented in the README and by design: a tool's `envVars` values are stored in the agent's JSONB and injected into `run_tool`. Anyone who can edit the tool can read them, and C1 exposes them to everyone until C1 is fixed. Flagging it so it is a conscious accepted risk, not a surprise: **do not store third-party secrets with more scope than the tool needs** (e.g. a full cloud key where a scoped token would do).

---

## LOW / HYGIENE

- **L1 — CORS `*` is broader than needed.** The widget endpoints (`meta`, `chat`, `[agentId]`) genuinely need `*`; the internal ones (C1, H1) do not and should have it removed as part of those fixes.
- **L2 — DLP is client-side in the widget.** `applyDlp` runs in the browser (`widget/[agentId].js`); a caller hitting the chat endpoint directly bypasses it. The server also masks in `_agentRunner.js` (`dlpMessages`), so this is defence-in-depth rather than a hole — but the masked-in-browser copy should not be mistaken for the guarantee. (Verified: the server does re-mask, so stored history is masked. Good.)
- **L3 — Widget renders messages with `textContent`, not `innerHTML`.** Checked for XSS in the widget bubble rendering — it uses `textContent` and `he()` escaping for interpolated values. No injection found. Noted here as a *pass*, so it stays a pass on the next edit.
- **L4 — Ownership checks reviewed across `agents/[id]/*`, `documents/[docId]`, `tables/[id]/*`, `gmail/send`.** All gate on `user_id = ${user.userId} or isAdmin`, via a join or an explicit `userOwnsAgent`/`ownedDoc` check, before reading or writing. No IDOR found in the authenticated endpoints. Also a *pass*, recorded so it stays one.
- **L5 — Invitation codes** (`api/_invites.js`): reviewed as part of today's work — hashed at rest, ~59 bits of entropy, claimed in a single atomic UPDATE, released on a failed registration. No brute-force oracle of concern (`invite-check` against a 59-bit space is not feasible, and there is no rate limit but also no reason one code helps guess another). *Pass.*

---

## Status — what has been fixed

Fixed and deployed (commits `Close the unauthenticated RCE…` and `A soft brake on guessing`), each verified against production:

- **C1 — DONE.** `/api/run-tool` now refuses anonymous callers (production returns `401`). It accepts only a signed-in browser (session JWT, verified in Python against the same key Node signs with) or the platform's own agent runner (an internal secret derived from `JWT_SECRET` identically on both sides). CORS `*` removed. Verified: JS↔Python token parity, and the test chat runs a tool through the authenticated path with no errors.
- **C2 — DONE.** The `change-me-in-production` fallback is gone from `_auth.js`, `gmail/auth.js`, `gmail/callback.js`; a missing `JWT_SECRET` now yields a random per-process key (fails closed) instead of a public constant. **Still to do by you:** confirm `JWT_SECRET` is set in Vercel (it is — tokens verify) and rotate it, since C1 means it must be assumed to have been readable.
- **H1 — DONE.** `scrape`, `scrape-browser`, `ollama-proxy` all refuse anonymous callers now (production returns `401`). `scrape` and `scrape-browser` also reject a URL that points at the machine or a private/link-local network (the `169.254` metadata range included). `ollama-proxy` still allows private hosts on purpose (a local Ollama is one); its protection is the auth gate.
- **H3 — DONE.** Login now brakes after 10 failures per username or per IP in a 15-minute window, and registration throttles per IP. It fails **open** (a database error leaves login working) and a correct password clears it, so it cannot lock out a real person. Covers **M2** (registration enumeration) via the same brake.

## Still open

- **H2 — deferred, deliberately.** The account API key is served to the browser because the browser calls `api.anthropic.com` / `api.openai.com` directly in dozens of places (test chat, platform assistant, wizard, key verification). Removing it means moving every model call server-side — a real feature-sized change with real regression risk. It should be done, but as its own project, not folded into a security patch. Until then the key's exposure is bounded by the session (only the signed-in owner receives it).
- **M1 — held, on purpose, for now.** `/api/gmail/auth` takes the session JWT in the query string. The fix (a short-lived single-use entry token) touches the live OAuth flow — the same flow you are mid-way through submitting to Google. Changing it this week risks the verification. Worth doing once Gmail is verified and stable.
- **M3 — accepted risk, documented.** Tool secrets are readable by anyone who can edit the tool. This is by design; the mitigation is operational (give a tool the narrowest-scoped credential that works).
- **Residual on H1:** the SSRF guard is a literal-IP check, so a hostname that *resolves* to a private address is not caught. Full coverage needs resolve-then-check; the literal guard closes the direct case without risking legitimate public crawls.

C1, C2 and H1 were the ones that made "anyone on the internet owns the server and the database." Those are closed.
