/** The whole point: a JSX error in agentforge.html is a blank screen. */
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const babel = require('@babel/standalone');

const file = process.argv[2] || new URL('../agentforge.html', import.meta.url).pathname;
const src = fs.readFileSync(file, 'utf8');
const blocks = [...src.matchAll(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/g)];
if (!blocks.length) { console.log('✗ no babel script block found'); process.exit(1); }

let bad = 0;
blocks.forEach((b, i) => {
  try {
    babel.transform(b[1], { presets: ['react'] });
    console.log(`✓ block ${i + 1} compiles (${b[1].split('\n').length} lines)`);
  } catch (e) {
    bad++;
    const line = src.slice(0, b.index).split('\n').length + (e.loc?.line || 0);
    console.log(`✗ block ${i + 1}: ${e.message.split('\n')[0]}  → agentforge.html:${line}`);
  }
});
process.exit(bad ? 1 : 0);
