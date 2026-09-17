/** Where the CLI keeps who you are: ~/.8legs/config.json, readable only by you. */
import fs from 'fs';
import os from 'os';
import path from 'path';

const DIR = path.join(os.homedir(), '.8legs');
const FILE = path.join(DIR, 'config.json');
export const DEFAULT_HOST = 'https://www.8legs.world';

export function readConfig() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function writeConfig(config) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  /* mode on writeFileSync only applies when the file is created. */
  fs.chmodSync(FILE, 0o600);
}

export function clearConfig() {
  try { fs.unlinkSync(FILE); } catch {}
}

export const configPath = FILE;
