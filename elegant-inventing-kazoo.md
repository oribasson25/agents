# AgentForge — תוכנית בנייה

## Context

הקובץ `AgentForge_Platform_Prompt.txt` בתיקייה מגדיר פלטפורמה לבניית AI Agents עם פרומפטים, Skills ו-Tools. המטרה: לבנות אותה כפרויקט שניתן לפרוס:

- **GitHub** — repo עם הקוד
- **Vercel** — אירוח (frontend סטטי + serverless functions)
- **Neon** — Postgres כ-storage לסוכנים, skills, tools

ה-frontend נשאר **קובץ HTML יחיד** (`agentforge.html`) שטוען React + Babel + Tailwind + Monaco דרך CDN — אין build step, אין bundler. ה-persistence נעשה דרך שכבה דקה של Vercel Serverless Functions תחת `/api/*` שמדברות עם Neon. הספק המקורי מציין "כל ה-state ב-memory" — אנחנו מרחיבים לכדי persistence ב-Neon כי המשתמש ביקש זאת במפורש לצורך deploy ושיתוף.

**יעד:** repo בתיקייה `/Users/oribasson/Documents/agents-b/` עם הקבצים המפורטים בסעיף "מבנה הפרויקט" למטה.

---

## Stack ותלויות (כולן דרך CDN, ללא bundler)

```html
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
```

- **React 18** + ReactDOM (UMD) — hooks: useState, useReducer, useEffect, useRef, useCallback
- **Babel Standalone** — לתרגום JSX ב-runtime, ה-`<script type="text/babel">` מכיל את כל קוד האפליקציה
- **Tailwind Play CDN** — ל-layout/utility classes (כפי שהספק דורש)
- **Monaco Editor** — דרך loader.min.js, נטען lazy ברגע שמגיעים ל-Tools tab
- **אייקונים: Emoji בלבד** (לפי בחירת המשתמש) — ✏️ 🗑 📤 ⚙️ 🕐 ⏱ ⚠ ▶ ▼ # @ 👁 וכד'. ללא lucide.
- **Persistence**: fetch ל-`/api/agents` (יחסי, אותו origin) — Vercel functions מתחת לאותו דומיין
- **קריאות API ל-Claude/OpenAI** נעשות ישירות מהדפדפן ל-providers (לא דרך הבקאנד שלנו) — המפתח של המשתמש ב-browser בלבד
- **ללא** dependencies נוספים בצד הלקוח — `crypto.randomUUID()` ל-id, פונקציות UTF-8/Base64 מקומיות ל-iframe encoding

### Backend (Vercel Functions)

```
/api/_db.js          // neon client singleton
/api/agents.js       // GET (list), POST (create)
/api/agents/[id].js  // GET (one), PUT (update), DELETE
```

תלויות backend ב-`package.json`:
```json
{
  "dependencies": {
    "@neondatabase/serverless": "^0.9.0"
  }
}
```

ללא Express, ללא Next.js — Vercel Functions vanilla (`export default async function handler(req, res)`). חיבור Neon דרך serverless driver שעובד על edge/node.

---

## מבנה הפרויקט

```
agents-b/
├── agentforge.html              # frontend יחיד, ~1800 שורות
├── api/
│   ├── _db.js                   # neon client singleton + helper queries
│   ├── agents.js                # GET list, POST create
│   └── agents/[id].js           # GET, PUT, DELETE
├── schema.sql                   # יצירת טבלאות ב-Neon (להרצה ידנית פעם אחת)
├── package.json                 # @neondatabase/serverless בלבד
├── package-lock.json            # ייווצר אוטומטית בהתקנה
├── vercel.json                  # rewrite "/" → "/agentforge.html"
├── .gitignore                   # node_modules, .env, .vercel
├── .env.example                 # DATABASE_URL=postgres://...
├── README.md                    # הוראות setup: clone → neon → vercel → env
└── AgentForge_Platform_Prompt.txt   # קיים, reference בלבד
```

### `agentforge.html` (frontend)

```
<head>
  ├── meta + title "AgentForge"
  ├── 5× CDN <script> (React, ReactDOM, Babel, Tailwind, Monaco loader)
  └── <style> — design tokens כ-CSS vars + scrollbar styling +
      keyframes (typing dots, card highlight, fade-in) + 'Segoe UI'
<body>
  ├── <div id="root">
  └── <script type="text/babel" data-presets="react">
      // ~1800 שורות; root.render(<App/>)
```

---

## מודל נתונים

### צורת ה-Agent בזיכרון (frontend)

```js
Agent = {
  id, name, avatar /* emoji */, openingMessage,
  basePrompt,
  skills: [{ id, name, description, prompt }],
  tools:  [{ id, name, description, code }],
  apiConfig: { provider: 'claude'|'openai', apiKey, model },
  createdAt
}
```

### Schema ב-Neon (Postgres) — JSONB מאוחד

טבלה אחת בלבד, פשטות מקסימלית (אנחנו לא צריכים queries על תתי-שדות):

```sql
-- schema.sql
create extension if not exists "pgcrypto";

create table if not exists agents (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agents_created_at_idx on agents (created_at desc);
```

`data` מכיל את כל ה-Agent JSON כולל skills/tools nested. עדכון = `update agents set data=$1, updated_at=now() where id=$2`. רשימה = `select id, data from agents order by created_at desc`.

### מפתחות API ב-DB + שכבת סיסמה (החלטה: מאוחסנים, מוגנים בסיסמה)

מפתחות `apiConfig.apiKey` **כן נשמרים** ב-Neon כחלק מ-`data` ה-JSONB. כדי למנוע גישה ציבורית, כל endpoints `/api/*` מוגנים בסיסמה אחת ראשית (`APP_PASSWORD`) שמוגדרת כ-env var ב-Vercel.

**זרימה:**
1. ב-Vercel: env var `APP_PASSWORD=<סיסמה שתבחר>` נוסף לצד `DATABASE_URL`.
2. **Backend** — כל handler ב-`api/` קורא ל-helper משותף:
   ```js
   // api/_auth.js
   export function checkAuth(req, res) {
     const provided = req.headers['x-app-password'];
     if (provided !== process.env.APP_PASSWORD) {
       res.status(401).json({ error: 'unauthorized' });
       return false;
     }
     return true;
   }
   ```
   קריאה ראשונה בכל handler: `if (!checkAuth(req,res)) return;`
3. **Frontend** — קומפוננטה `<PasswordGate>` עוטפת את `<App/>`:
   - ב-mount: בודקת `sessionStorage.getItem('agentforge_pw')` (מתאפס בסגירת tab).
   - אם אין: מציגה מסך login דארק עם input password יחיד + כפתור "Unlock". מבצעת `GET /api/agents` עם `x-app-password` ההזנה. אם 200 → שומרת ב-sessionStorage ומציגה את האפליקציה. אם 401 → מציגה "סיסמה שגויה".
   - כל ה-fetch helpers (`apiList`, `apiCreate`, `apiUpdate`, `apiDelete`) מוסיפים אוטומטית את ה-header `x-app-password` מ-`sessionStorage`.
   - אם בקריאה כלשהי מתקבל 401 → flush sessionStorage והצגת מסך הסיסמה מחדש.
4. **תוצאה**: כל מי שיגלוש ל-URL יראה תחילה את מסך ה-Unlock; ללא הסיסמה הנכונה אי אפשר לקרוא או לכתוב סוכנים, ולא לחשוף את מפתחות ה-API.

**הערות אבטחה:**
- הסיסמה מועברת רק על HTTPS (Vercel default). זה פשוט אבל מספק מהבחינה המעשית למשתמש יחיד.
- `sessionStorage` נמחק בסגירת ה-tab; חידוש דורש הקלדה מחדש (lo-fi UX אבטחה סביר).
- אין hashing — השוואה ישירה ל-env var. אפשר לשדרג ל-bcrypt עתידית, לא נכלל בגרסה הראשונה.
- אם בעתיד תרצה להחליף סיסמה — מספיק לעדכן את ה-env var ב-Vercel ולפרוס מחדש.

### State management ב-frontend

`useReducer` ב-`<App/>` עם actions:
`HYDRATE` (מלוקאלי load מ-`/api/agents` בעלייה), `CREATE_AGENT`, `UPDATE_AGENT`, `DELETE_AGENT`, `DUPLICATE_AGENT`, `ADD_SKILL`, `UPDATE_SKILL`, `DELETE_SKILL`, `ADD_TOOL`, `UPDATE_TOOL`, `DELETE_TOOL`, `SET_VIEW`, `OPEN_CHAT`, `CLOSE_CHAT`.

מעבר ל-actions של create/delete/duplicate שמסונכרנים מיד עם הבקאנד, כל עדכון תוכן (typing ב-prompt, change ב-config) עובר דרך **debounce של 600ms** לפני `PUT /api/agents/:id` כדי להימנע מ-flooding. ה-context מספק `saveAgentDebounced(agent)` לקומפוננטות הילדים.

---

## עץ קומפוננטות

```
<PasswordGate>           // מסך Unlock; עוטף את כל האפליקציה
└── <App>
├── <Sidebar/>                    // 240px, lateral nav, version badge
├── <Main>
│   ├── <AgentListView/>          // grid של AgentCards + FAB "+ New Agent"
│   │   └── <AgentCard/> ×N       // hover glow, actions: Edit/Test/Duplicate/Delete/Export
│   └── <AgentEditor/>            // tabs: Configuration | Skills | Tools | Export
│       ├── <TabBar/>             // pill tabs
│       ├── <ConfigurationTab/>
│       │   ├── <EmojiAvatarPicker/>
│       │   ├── <ApiConfigCard/>  // provider toggle pill, key w/ eye, model select
│       │   └── <RichPromptEditor/> // base prompt
│       ├── <SkillsTab/>
│       │   ├── <SkillRow/> ×N    // drag handle, name, desc, edit/delete
│       │   └── <SkillEditorPanel/> // expandable: name, desc, RichPromptEditor
│       ├── <ToolsTab/>
│       │   ├── <ToolRow/> ×N
│       │   └── <ToolEditorPanel/> // name, desc, <MonacoPython/>
│       └── <ExportTab/>
│           ├── <ExportControls/> // title, color, radius slider, height slider, placeholder, copy btn
│           ├── <LivePreviewPanel/> // משתמש ב-<MiniChatWidget/> פנימי
│           └── <IframeCodeBlock/> // dark mono code block
└── <ChatTestDrawer/>              // right drawer 420px, רנדר חופף ב-portal
    ├── <ChatHeader/>              // avatar, name, conn dot, X
    ├── <MessageList/>
    │   ├── <MessageBubble/> ×N    // user/agent/tool/skill-switch/error variants
    │   └── <TypingIndicator/>     // 3 dots animated
    └── <ChatInput/>                // textarea dir=auto, send, Enter/Shift+Enter
```

קומפוננטות עזר משותפות: `<RichPromptEditor/>` (משומש פעמיים), `<MonacoPython/>` (מעטפת ל-Monaco), `<IconButton/>`, `<EmptyState/>`.

---

## Backend — פירוט endpoints

### `api/_db.js`
```js
import { neon } from '@neondatabase/serverless';
export const sql = neon(process.env.DATABASE_URL);
```

### `api/_auth.js`
```js
export function checkAuth(req, res) {
  const provided = req.headers['x-app-password'];
  if (!process.env.APP_PASSWORD || provided !== process.env.APP_PASSWORD) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}
```

### `api/agents.js`
```js
import { sql } from './_db.js';
import { checkAuth } from './_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  if (req.method === 'GET') {
    const rows = await sql`select data from agents order by created_at desc`;
    return res.json(rows.map(r => r.data));
  }
  if (req.method === 'POST') {
    const agent = req.body;
    await sql`insert into agents (id, data) values (${agent.id}, ${JSON.stringify(agent)}::jsonb)`;
    return res.status(201).json(agent);
  }
  res.status(405).end();
}
```

### `api/agents/[id].js`
```js
import { sql } from '../_db.js';
import { checkAuth } from '../_auth.js';

export default async function handler(req, res) {
  if (!checkAuth(req, res)) return;
  const { id } = req.query;
  if (req.method === 'GET') {
    const [row] = await sql`select data from agents where id=${id}`;
    return row ? res.json(row.data) : res.status(404).end();
  }
  if (req.method === 'PUT') {
    const agent = req.body;
    await sql`update agents set data=${JSON.stringify(agent)}::jsonb, updated_at=now() where id=${id}`;
    return res.json(agent);
  }
  if (req.method === 'DELETE') {
    await sql`delete from agents where id=${id}`;
    return res.status(204).end();
  }
  res.status(405).end();
}
```

מפתחות API נשמרים כחלק מ-`data` ה-JSONB, בלי stripping.

הערות:
- Vercel מפענח JSON body אוטומטית עבור functions עם `Content-Type: application/json`
- `@neondatabase/serverless` משתמש ב-HTTP fetch — תואם Node serverless וגם Edge runtime
- ללא ORM, ללא migrations framework — `schema.sql` מורץ ידנית פעם אחת ב-Neon SQL editor

---

## רכיבים קריטיים — פירוט מימוש

### `<RichPromptEditor/>`
- מחזיק `mode: 'edit'|'preview'` ו-`collapsed: Set<string>` (מפתחות headings)
- **Edit**: textarea מונוספייס bg `#252837`, `dir="auto"`, min-h 320px, auto-grow על שינוי, character counter ב-bottom-right (`text.length`)
- **Preview**: parse ל-sections לפי regex `^## (.+)$`. כל section: header pill (`#2a2d3e`) עם ▶/▼ ו-title bold, body מודגש typography. בתוך body: regex לזיהוי `@\w+` (purple chip `#6c63ff`) ו-`#\w+` (teal chip `#14b8a6`)
- toolbar למעלה: כפתור `## Heading` (מכניס `\n## כותרת חדשה\n` במיקום cursor), Collapse All / Expand All, Edit/Preview pill toggle

### `<MonacoPython/>`
- `useEffect` ראשוני: אם `window.monaco` לא קיים — קורא ל-`require.config({paths:{vs:'…/min/vs'}})` ואז `require(['vs/editor/editor.main'], cb)`. שומר promise ב-module-level singleton למניעת טעינה כפולה
- יוצר instance עם `theme:'vs-dark', language:'python', fontSize:14, fontFamily:"'JetBrains Mono','Fira Code',monospace", lineNumbers:'on', minimap:{enabled:true}, automaticLayout:true`
- `onDidChangeModelContent` → callback prop `onChange(value)`
- container: 100% × 400px min, `border-radius:12px overflow:hidden border:1px solid #2a2d3e`
- cleanup: `editor.dispose()` ב-unmount

### `<ChatTestDrawer/>` — לוגיקת תזמון תגובה
ה-state של ההודעות:
```js
messages: { id, role: 'user'|'agent'|'tool'|'skill'|'error', content, timestamp, durationMs?, isOpening? }[]
pending: boolean
```
זרימה ב-`sendMessage`:
1. `const t0 = performance.now()` — לפני קריאת fetch
2. `setPending(true)` ו-push של typing indicator
3. בונה payload לפי `apiConfig.provider`:
   - **Claude**: POST `https://api.anthropic.com/v1/messages` עם headers `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`, body כולל `system` (basePrompt + concatenated skills), `messages`, `model`, `max_tokens`
   - **OpenAI**: POST `https://api.openai.com/v1/chat/completions` עם `Authorization: Bearer …`, system message + history
4. כשמתקבלת תגובה: `const dt = performance.now() - t0`, מסיר typing indicator, מוסיף הודעת agent עם `durationMs: dt`, `timestamp: new Date()`
5. שגיאה: הודעת error עם `Failed after X.XXs` ו-`durationMs`
- בכל bubble agent מציג metadata row מתחת: `⏱ {(dt/1000).toFixed(2)}s • 🕐 {HH:MM}` בצבע `#5c6380` 11px
- הודעת opening מקבלת `isOpening:true` → מציג `🕐 HH:MM` בלבד ללא `⏱`
- **typing indicator**: bubble בסטייל agent עם 3 spans, CSS animation `pulse-dot` עם `animation-delay: 0s/0.15s/0.3s`
- **#SkillName parsing**: לפני שליחה, regex `^#(\w+)` בהתחלת ההודעה → אם תואם skill קיים, מציג banner "Switched to skill: X" וצירוף ה-skill prompt לראש ה-system message
- **@toolName**: מסומן ב-bubble כ-chip סגול, אבל ביצוע אמיתי לא מתרחש (אין sandbox פייתון בדפדפן). הספק לא דורש runtime ביצוע — רק תיוג ויזואלי
- detect Hebrew: `/^[\u0590-\u05FF]/.test(text.trim())` → `dir="rtl"` אחרת `"ltr"`
- Escape key listener (`useEffect`+`document.addEventListener`) → close drawer
- backdrop overlay `rgba(0,0,0,0.5)`, drawer slide-in via CSS `transform: translateX(0)` עם transition

### `<ExportTab/>` — Live Preview + iframe
- state מקומי: `widgetTitle, accentColor, borderRadius, widgetHeight, placeholder` — כולם עם ברירת מחדל מה-agent
- `<LivePreviewPanel>` משתמש בקומפוננטה פנימית `<MiniChatWidget agent={…} accent={…} radius={…} height={…} placeholder={…}/>` — קומפוננטת React מלאה אינטראקטיבית, רצה in-page (לא iframe), משתמשת באותו סשן API. כל שינוי controls גורם re-render אוטומטי כי הם props.
- אם אין `apiKey` — מציגה banner "Add an API key in Configuration to test live"
- `generateIframeHtml(agent, opts)`: בונה string HTML שלם:
  - `<!doctype html><html><head><style>…dark css עם accent…</style></head>`
  - `<body><div id="header">{title}</div><div id="messages"></div><form>…</form></body>`
  - `<script>` עם system prompt משובץ (basePrompt + כל skill prompts מסומנים `## Skill: name`), API key משובץ, פונקציית send שזהה ללוגיקה ב-drawer, detect Hebrew, אפס תלויות
- `encodeURIComponent` של ה-HTML, מכניס ל-`data:text/html;charset=utf-8,…`
- מציג ב-`<IframeCodeBlock/>` דארק, מונוספייס, סקרולל, ניתן לסימון
- כפתור Copy: `navigator.clipboard.writeText(iframe)` → `setCopied(true)` → `setTimeout(setCopied(false), 2000)` → אייקון משתנה ל-✓

### `<AgentListView/>` ו-Duplicate
- DUPLICATE: `JSON.parse(JSON.stringify(agent))`, החלפת `id` ב-`crypto.randomUUID()`, name + " (Copy)", הזרקת `_isNew:true` flag → ה-card מקבל `animation: highlight 1.2s ease-out` (CSS keyframes שמהבהב את ה-border בצבע primary)
- empty state: SVG/emoji + "No agents yet — click + New Agent to start"

---

## design tokens — CSS vars

```css
:root {
  --bg-app:#0f1117; --bg-sidebar:#13151c; --bg-card:#1a1d27;
  --bg-panel:#1e2130; --bg-input:#252837; --bg-hover:#2a2d3e;
  --primary:#6c63ff; --primary-hover:#7c74ff;
  --success:#22c55e; --warning:#f59e0b; --danger:#ef4444; --teal:#14b8a6;
  --text:#f0f0f5; --text-2:#9ca3af; --text-muted:#5c6380;
  --border:#2a2d3e; --border-focus:#6c63ff;
  --r-sm:6px; --r-md:12px; --r-lg:18px; --r-xl:24px;
  --shadow: 0 4px 24px rgba(0,0,0,0.4);
}
body { background:var(--bg-app); color:var(--text); font-family:'Segoe UI','Arial',sans-serif; }
```

Tailwind משמש ל-flex/grid/spacing/typography utilities; tokens של צבע מוחלים דרך `style={{background:'var(--bg-card)'}}` או class arbitrary `bg-[#1a1d27]`. כל הקלטים והאזורי טקסט: `dir="auto"` חוץ מ-Monaco שנשאר LTR.

---

## רשימת פיצ'רים נגד הספק (checklist)

- [ ] Sidebar 240px עם logo "AgentForge", Home/Documentation/Settings, version badge
- [ ] Agent list grid עם cards: avatar gradient, name, skill/tool count badges, hover glow, 5 actions
- [ ] FAB "+ New Agent" rounded pill primary
- [ ] Editor: 4 tabs pill בסטייל
- [ ] Configuration: name + emoji picker, opening message, API config card עם provider toggle pill, key+eye, model dropdown מותאם פר provider, RichPromptEditor ל-base prompt
- [ ] Skills tab: list עם drag handle (visual בלבד או drag-to-reorder אופציונלי), inline editor, tooltip על #SkillName
- [ ] Tools tab: list, ToolEditor עם MonacoPython 400px, tooltip על @toolName
- [ ] Export tab: 2 columns, controls חיים, MiniChatWidget אינטראקטיבי, iframe code block, copy עם ✓ animation
- [ ] iframe HTML שלם, self-contained, RTL-aware
- [ ] RichPromptEditor: ## headings, collapse/expand, edit/preview pill, char counter, @/# chips
- [ ] ChatTestDrawer 420px right, header/messages/input, escape closes
- [ ] Response timing: ⏱ X.XXs • 🕐 HH:MM, opening = 🕐 only, error = ⚠ Failed after X.XXs
- [ ] Typing indicator 3 dots staggered
- [ ] RTL detection ב-bubbles
- [ ] Duplicate agent עם highlight animation
- [ ] Model lists: claude (opus/sonnet/haiku 4-5), openai (4o/4o-mini/4-turbo/3.5-turbo)
- [ ] Auto-save state on change
- [ ] Empty states ב-list ו-skills/tools ריקים
- [ ] Escape closes drawers
- [ ] קריאות API אמיתיות ל-Claude/OpenAI ישירות מהדפדפן

---

## קבצים שייווצרו

| נתיב | פעולה |
|---|---|
| `agentforge.html` | **חדש** — frontend יחיד ~1800 שורות |
| `api/_db.js` | **חדש** — neon client singleton |
| `api/_auth.js` | **חדש** — `checkAuth(req,res)` נגד `APP_PASSWORD` |
| `api/agents.js` | **חדש** — list / create (מוגן בסיסמה) |
| `api/agents/[id].js` | **חדש** — get / update / delete (מוגן בסיסמה) |
| `schema.sql` | **חדש** — DDL להרצה ב-Neon SQL Editor |
| `package.json` | **חדש** — `@neondatabase/serverless` |
| `vercel.json` | **חדש** — `{"rewrites":[{"source":"/","destination":"/agentforge.html"}]}` |
| `.gitignore` | **חדש** — `node_modules/`, `.env*`, `.vercel/` |
| `.env.example` | **חדש** — `DATABASE_URL=postgres://...` + `APP_PASSWORD=changeme` |
| `README.md` | **חדש** — הוראות setup קצרות (להלן) |
| `AgentForge_Platform_Prompt.txt` | reference, לא נוגעים |

### תוכן `README.md` (תקציר)
1. `git clone <repo>`
2. ב-Neon: ליצור project, להריץ `schema.sql` ב-SQL Editor, להעתיק את ה-connection string
3. ב-Vercel: Import Project → הוסף env vars: `DATABASE_URL` (מ-Neon) ו-`APP_PASSWORD` (תבחר סיסמה)
4. Push ל-main → auto deploy (או `vercel deploy --prod`)
5. גישה ל-URL → מסך Unlock → הקלד את הסיסמה → האפליקציה נטענת
6. הערות אבטחה: כל מי שיודע את הסיסמה יכול לקרוא ולערוך את הסוכנים, כולל המפתחות. אל תשתף את הסיסמה ב-public.

### דרישות הרצה לוקאלית (אופציונלי)
- `npm install`
- ליצור `.env.local` עם `DATABASE_URL` ו-`APP_PASSWORD`
- `vercel dev` — מפעיל את ה-functions וה-static יחד על `localhost:3000`

---

## אימות end-to-end

### לוקאלית (לפני deploy)

1. **התקנה**: `npm install` בתיקייה.
2. **DB**: ליצור project ב-Neon, להריץ `schema.sql`, לשמור connection string ב-`.env.local` כ-`DATABASE_URL=…`.
3. **הרצה**: `vercel dev` → פותח `http://localhost:3000`.
4. אין שגיאות ב-DevTools console (Babel warnings על production הם תקינים).
5. ב-Network: `GET /api/agents` מחזיר `[]` בריצה ראשונה.

### deploy

6. `git init && git add . && git commit -m "init agentforge"` → push ל-GitHub.
7. ב-Vercel: Import → לבחור את ה-repo → להוסיף env var `DATABASE_URL` (מ-Neon) → Deploy.
8. לבדוק שה-URL הציבורי טוען את ה-UI ושיצירת agent חדש שורדת רענון.

### בדיקות פונקציונליות (לוקאלית או על production)
2. **יצירת agent**: לחיצה על "+ New Agent" → editor נפתח מיידית עם ברירות מחדל.
3. **Configuration**: שינוי name/avatar/opening, החלפת provider, הקלדת מפתח API, בחירת מודל, כתיבת base prompt עם `## Section 1` ו-`## Section 2`, מעבר ל-Preview ובדיקה שכותרות מתקפלות, ש-`@search` מסומן סגול ו-`#analysis` תכלת.
4. **Skills**: הוספת skill עם name+desc+prompt. חזרה ל-list ובדיקה שספירת skills בעדכון ב-card.
5. **Tools**: הוספת tool, וידוא ש-Monaco נטען עם תחביר Python, line numbers, minimap.
6. **Chat test**: לחיצה על Test → drawer נפתח ימינה, opening message מוצגת עם 🕐 HH:MM בלבד. שליחת הודעה → typing indicator → תגובה אמיתית מ-Claude/OpenAI עם `⏱ X.XXs • 🕐 HH:MM`. שליחה בעברית → bubble RTL. שליחת `#SkillName` → banner switch. שליחה ללא מפתח / מפתח שגוי → bubble אדומה `⚠ Failed after X.XXs`.
7. **Duplicate**: לחיצה על Duplicate ב-card → card חדש עם " (Copy)" עם animation בולט.
8. **Export**: כניסה ל-Export tab, שינוי accent color/radius/height → live preview משתנה מיידית. שליחת הודעה ב-preview → תגובה אמיתית. לחיצה על Copy iframe → ✓ למשך 2 שניות. הדבקת ה-iframe ב-`<body>` של קובץ HTML חדש בלוקאל ובדיקה שהווידג'ט עובד עצמאית.
9. **Escape**: לחיצה על Esc תוך כדי drawer פתוח → סגירה.
10. **Persistence**: רענון הדף → מסך Unlock (אם נסגר ה-tab) או טעינה ישירה (אם הסיסמה ב-sessionStorage). הסוכנים, skills, tools, **כולל מפתחות ה-API** נטענים מחדש מ-Neon.
11. **Cross-device**: פתיחה של אותו URL בדפדפן/מכשיר אחר → מסך Unlock → אחרי הסיסמה, אותם סוכנים בדיוק.
12. **Auth negative**: גישה ל-`/api/agents` ללא header `x-app-password` (או עם סיסמה שגויה) → 401. סיסמה שגויה במסך Unlock → הודעת שגיאה אדומה.

---

## סיכונים ידועים

- **סיסמה אחת משותפת**: אין משתמשים נפרדים — מי שיודע את `APP_PASSWORD` יכול לראות הכל, כולל מפתחות ה-API. מתאים לשימוש אישי או צוות קטן בלבד.
- **השוואת סיסמה ישירה (לא hashed)**: השוואה מילולית מול env var. עבור public deploy עם משתמש אחד זה סביר. ניתן לשדרג ל-bcrypt בעתיד.
- **המפתחות חשופים בדפדפן**: כל מי שעבר את שכבת ה-Unlock רואה את המפתחות של כל הסוכנים ב-React state. זה הכרחי כי הקריאות ל-Claude/OpenAI נעשות מהדפדפן.
- **CORS / Direct browser access**: Claude API דורש header `anthropic-dangerous-direct-browser-access: true`. OpenAI מאפשרת קריאות ישירות מהדפדפן.
- **Babel runtime cost**: טעינה ראשונה איטית במעט (~1-2 שניות). מקובל לכלי dev/admin.
- **Tailwind Play CDN**: לא מומלץ ל-production גדול אבל סביר לכלי אישי.
- **Monaco loader**: lazy על Tools tab.
- **Neon cold start**: HTTP driver של Neon מהיר יחסית, אבל הקריאה הראשונה אחרי idle עלולה לקחת כמה מאות ms — לא מורגש משמעותית.
- **גודל קובץ frontend**: ~1500-2000 שורות, מסומן ב-section comments.
