/* The mark as a standalone SVG string, for the places that build HTML rather
   than JSX: the embed snippet and the widget the server renders. The browser
   has its own copy of this in agentforge.html, as JSX. */

/** The eight colours an AI Chatbot can wear, and how an older avatar maps in. */
export const MARK_COLORS = [
  '#EF9F27', '#0d9488', '#6d5ce0', '#2563eb',
  '#16a34a', '#dc2626', '#db2777', '#475569',
];

/**
 * Anything that is not a hex colour comes from before the mark replaced emoji
 * and uploaded pictures; it is turned into a colour by its own text, so it
 * stays the same colour every time rather than changing on each render.
 */
export function markColor(value) {
  const v = (value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (!v) return MARK_COLORS[0];
  let h = 0;
  for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0;
  return MARK_COLORS[h % MARK_COLORS.length];
}

export function markSvg(color, size = 30) {
  const c = /^#[0-9a-f]{6}$/i.test((color || '').trim()) ? color.trim() : '#EF9F27';
  const dark = (hex, amount) => {
    const n = parseInt(hex.slice(1), 16);
    const mix = v => Math.round(v * (1 + amount));
    return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix)
      .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  };
  const eye = dark(c, -0.55), tip = dark(c, -0.35);
  const leg = (pts) => `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="272 20 136 136" width="${size}" height="${size}">`
    + `<ellipse cx="340" cy="108" rx="21" ry="29" fill="${c}"/>`
    + `<ellipse cx="340" cy="72" rx="14" ry="14" fill="${c}"/>`
    + `<circle cx="335" cy="70" r="3.5" fill="${eye}"/><circle cx="345" cy="70" r="3.5" fill="${eye}"/>`
    + `<path d="M345,136 C372,138 390,122 390,98 C390,72 374,56 379,38" fill="none" stroke="${c}" stroke-width="8" stroke-linecap="round"/>`
    + `<polygon points="375,40 382,24 389,40" fill="${tip}"/>`
    + leg('319,95 293,80 278,72') + leg('319,105 291,102 276,100') + leg('319,115 291,119 276,124') + leg('319,125 293,136 281,146')
    + leg('361,95 387,80 402,72') + leg('361,105 389,102 404,100') + leg('361,115 389,119 404,124') + leg('361,125 387,136 399,146')
    + `<path d="M328,62 L313,48" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round"/>`
    + `<path d="M313,48 L304,40" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`
    + `<path d="M313,48 L309,57" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`
    + `<path d="M352,62 L367,48" fill="none" stroke="${c}" stroke-width="4.5" stroke-linecap="round"/>`
    + `<path d="M367,48 L376,40" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`
    + `<path d="M367,48 L371,57" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`
    + `</svg>`;
}
