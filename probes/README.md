# Probes

`npm run probe` runs everything here. They exist because the two riskiest
files have no build step and no test framework: `agentforge.html` fails as a
blank screen, and a bug in `_agentFiles.js` deletes fields from a live agent.

| Probe | What it protects |
|---|---|
| `roundtrip-probe.mjs` | an agent survives being turned into files and back |
| `files-api-probe.mjs` | pull, push, and every refusal that must write nothing |
| `branches-probe.mjs` | drafts, merges, traffic splits, conversation stickiness |
| `cli-probe.mjs` | the real CLI binary against a stand-in platform |
| `github-probe.mjs` | git as a real remote, and every push it must refuse |
| `check-jsx.mjs` | agentforge.html compiles |
| `render-probe.mjs` | its new components actually render |

`check-jsx` and `render-probe` need `@babel/standalone`, `react` and
`react-dom`, which the platform does not use at runtime. They are listed in
`probes/package.json`: run `npm install --prefix probes` once. The install is
gitignored.
