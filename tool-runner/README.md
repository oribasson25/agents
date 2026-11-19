# Tool runner

The Python that customers write for their chatbots' tools and their
automations' code steps runs here, in a Vercel project of its own that holds
no secret of the platform's.

## Why a separate project

`api/run_tool.py` runs each tool in a child process whose environment holds
only the tool's own variables. That keeps `os.environ` clean, but on Linux a
process can still read `/proc/<pid>/environ` of any process running as the
same user — its parent included. On the platform's own deployment the parent
holds `DATABASE_URL`, `JWT_SECRET` and the provider keys, so customer code
running there is one file read away from all of them.

Here, the only secret in the environment is `TOOL_RUNNER_SECRET`, and all it
does is let the platform ask this project to run code. Reading it gets an
attacker exactly what they already had.

`tool-runner/api/run_tool.py` and `api/run_tool.py` are the same file; the
`accounts-security` probe fails if they differ. Change one, copy it over.

## Deploying it

1. In Vercel, create a new project from this repository and set its **Root
   Directory** to `tool-runner`. No framework, no build command.
2. In that project's environment variables set **only**
   `TOOL_RUNNER_SECRET` — a long random value (`openssl rand -hex 32`). Do not
   copy the platform's variables into it.
3. On the main project set:
   - `TOOL_RUNNER_URL` — the runner's address, e.g. `https://8legs-tool-runner.vercel.app`
   - `TOOL_RUNNER_SECRET` — the same value as in step 2.
4. Redeploy the main project. `api/_toolRunner.js` sends every run to
   `TOOL_RUNNER_URL` from then on; without it, runs fall back to the main
   project's own `/api/run-tool`.
5. Test a tool from the chatbot editor and a code step from an automation.

## Then rotate everything

Until step 4, any account that could edit a chatbot could run code beside the
platform's secrets, and before this change any signed-in account could. Treat
every secret the main project held as read:

- `JWT_SECRET` — signs everyone out; that is the point.
- The database password in `DATABASE_URL` (rotate it in Neon, then update the variable).
- The OpenRouter key.
- `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET`, the GitHub token and webhook secret.
- `CRON_SECRET`.
- `CONNECTIONS_KEY` — the stored connection tokens are encrypted with it, so
  they have to be re-encrypted with the new key or connected again. If it was
  never set, the key was derived from `JWT_SECRET`, and rotating that has the
  same effect.

Afterwards, look through the Vercel logs for calls to `/api/run-tool` that did
not come from the platform (anything before this change that carried an
`Authorization` header).

## What this still does not isolate

Two customers' runs that land on the same warm instance share a machine and a
user: one could read the other's process environment (its tool variables) or
tamper with files in `/tmp`. Package folders are fingerprinted and reinstalled
if anything changes between runs, which catches tampering that happens between
runs but not during one. Full isolation needs a sandbox per run (Vercel
Sandbox, Firecracker, E2B).
