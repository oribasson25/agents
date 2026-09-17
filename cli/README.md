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
