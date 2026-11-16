# @8legs/cli

Edit an [8Legs](https://www.8legs.world) agent in your own editor, then push it.

```bash
npx @8legs/cli login
npx @8legs/cli list
npx @8legs/cli pull my-agent
```

You now have a folder holding the whole agent: `prompt.md` is the base prompt,
`config.json` is its identity and channels, and there is a directory per skill
and per tool. Edit them, then:

```bash
8legs status     # what changed, here and on the platform
8legs diff       # the changes themselves
8legs push
```

## Apps

An app — a small web interface the platform hosts — is edited the same way:

```bash
8legs apps                   # your apps, with their slugs
8legs pull --app leads-desk  # app.json plus the app's own files
8legs push                   # live at once, and kept as a version
8legs versions
8legs rollback 3             # make version 3 live again
```

## Automations

An automation — a trigger and steps the platform runs — is a folder too:

```bash
8legs automations                          # your automations, and which are live
8legs pull --automation "New lead follow-up"
8legs push                                 # saves the draft; nothing live changes
8legs run --input '{"name": "Dana"}'       # runs the draft, prints every step
8legs publish                              # makes the draft what the trigger fires
8legs versions
8legs rollback 2
```

`automation.json` holds the trigger, the steps and how they connect;
`steps/<id>.py` is the code of each Code step; `layout.json` is where the
boxes sit on the canvas, and can be left out. `AGENTS.md` in the folder
documents every kind of step.

## What is not in the folder

Secrets never land on disk. The account's API key, the WhatsApp tokens and each
tool's environment values stay in the platform; `config.json` refers to one as
`{{global.NAME}}`. Do not replace a reference with a literal — push preserves
whatever the platform already holds, so a literal would simply be ignored.

Knowledge-base documents are not in the folder either. They have their own
lifecycle — upload, chunking, indexing — and a crawl of a few hundred pages has
no business being a commit.

## When a push is refused

**"The agent changed on the platform since you pulled"** — someone edited it in
the browser. `8legs pull` takes their version, then redo your edit and push
again. Nothing was written.

**A file did not parse** — nothing was written either. A push is all or
nothing: a broken JSON file can never leave a live agent half updated.

## Installing

Needs Node 18 or newer. `npx @8legs/cli <command>` runs it without installing;
`npm i -g @8legs/cli` puts `8legs` on your PATH.
