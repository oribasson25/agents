import { sql } from '../_db.js';

function he(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { agentId } = req.query;
  const accent      = req.query.accent      || '#6c63ff';
  const titleColor  = req.query.titleColor  || '#ffffff';
  const titleParam  = req.query.title       || '';
  const placeholder = req.query.placeholder || 'Type a message\u2026';
  const height      = parseInt(req.query.height) || 500;

  const [row] = await sql`select data from agents where id = ${agentId}`;
  if (!row) return res.status(404).send('Agent not found');

  const agent = row.data;
  const titleStr   = titleParam || agent.name || 'Agent';
  const avatarRaw  = agent.avatar  || '\uD83E\uDD16';
  const avatarIsImage = avatarRaw.startsWith('data:') || avatarRaw.startsWith('http');
  const avatarHtml = avatarIsImage
    ? `<img src="${he(avatarRaw)}" style="width:30px;height:30px;border-radius:50%;object-fit:cover">`
    : he(avatarRaw);
  const openingStr = agent.openingMessage || 'Hello!';

  const jsChatUrl = JSON.stringify(`/api/widget/${agentId}/chat`);
  const jsOpening = JSON.stringify(openingStr);
  const jsDlp     = JSON.stringify(agent.dlp || {});

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#f0f0f5;font-family:'Segoe UI',Arial,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
#header{background:${he(accent)};padding:12px 16px;display:flex;align-items:center;gap:10px}
#header .av{font-size:22px}
#header .nm{font-weight:700;color:${he(titleColor)};font-size:15px}
#messages{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
#messages::-webkit-scrollbar{width:4px}
#messages::-webkit-scrollbar-thumb{background:#2a2d3e;border-radius:2px}
.bubble-wrap{display:flex;flex-direction:column}
.bubble-wrap.user{align-items:flex-end}
.bubble-wrap.agent,.bubble-wrap.error{align-items:flex-start}
.bubble{max-width:80%;padding:10px 14px;font-size:14px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.bubble.user{background:${he(accent)};color:#fff;border-radius:18px 18px 4px 18px}
.bubble.agent{background:#1e2130;color:#f0f0f5;border-radius:18px 18px 18px 4px}
.bubble.error{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:18px 18px 18px 4px}
.meta{font-size:11px;color:#5c6380;padding:2px 4px}
.meta.err{color:#ef4444}
.typing{display:flex;gap:5px;padding:12px 16px;background:#1e2130;border-radius:18px 18px 18px 4px;width:fit-content}
.dot{width:8px;height:8px;background:#9ca3af;border-radius:50%;animation:pd 1.2s infinite ease-in-out}
.dot:nth-child(2){animation-delay:.15s}.dot:nth-child(3){animation-delay:.3s}
@keyframes pd{0%,80%,100%{opacity:.3;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
#inputbar{padding:10px 12px;background:#1e2130;border-top:1px solid #2a2d3e;display:flex;gap:8px}
textarea{flex:1;background:#252837;color:#f0f0f5;border:1px solid #2a2d3e;border-radius:12px;padding:8px 12px;font-family:inherit;font-size:13px;outline:none;resize:none}
textarea:focus{border-color:${he(accent)}}
button{background:${he(accent)};color:#fff;border:none;padding:0 14px;border-radius:12px;font-size:18px;cursor:pointer;font-weight:700}
button:disabled{opacity:.4;cursor:not-allowed}
</style>
</head>
<body>
<div id="header"><span class="av">${avatarHtml}</span><span class="nm">${he(titleStr)}</span></div>
<div id="messages"></div>
<div id="inputbar">
  <textarea id="inp" placeholder="${he(placeholder)}" rows="1" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg()}"></textarea>
  <button onclick="sendMsg()">&#x27A4;</button>
</div>
<script>
var CHAT_URL=${jsChatUrl};
var DLP=${jsDlp};
var chatHistory=[];
var pending=false;
function applyDlp(t){
  if(!t)return t;
  if(DLP.creditCard)t=t.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,'[MASKED]');
  if(DLP.israeliId)t=t.replace(/\b\d{9}\b/g,'[MASKED]');
  return t;
}
var SESSION_ID=(function(){var a='0123456789abcdef',s='';for(var i=0;i<24;i++)s+=a[Math.floor(Math.random()*16)];return s})();
function isHeb(t){return /^[\u0590-\u05FF]/.test((t||'').trim())}
function fmt(d){return new Date(d).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false})}
var msgs=document.getElementById('messages');
function addMsg(role,content,ts,dt){
  var wrap=document.createElement('div');
  wrap.className='bubble-wrap '+role;
  var b=document.createElement('div');
  b.className='bubble '+role;
  b.textContent=content;
  b.dir=isHeb(content)?'rtl':'ltr';
  wrap.appendChild(b);
  if(role==='agent'||role==='error'){
    var m=document.createElement('div');
    m.className='meta'+(role==='error'?' err':'');
    m.textContent=role==='error'?('\\u26A0 Failed after '+dt+'   \\u2022   \\uD83D\\uDD50 '+fmt(ts)):(dt?('\\u23F1 '+dt+'   \\u2022   \\uD83D\\uDD50 '+fmt(ts)):('\\uD83D\\uDD50 '+fmt(ts)));
    wrap.appendChild(m);
  }
  msgs.appendChild(wrap);
  msgs.scrollTop=msgs.scrollHeight;
}
function showTyping(){
  var d=document.createElement('div');d.id='typing';d.className='typing';
  d.innerHTML='<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
  msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;
}
function hideTyping(){var d=document.getElementById('typing');if(d)d.remove()}
addMsg('agent',${jsOpening},new Date());
async function sendMsg(){
  var inp=document.getElementById('inp');
  var text=applyDlp(inp.value.trim());
  if(!text||pending)return;
  inp.value='';inp.style.height='auto';
  chatHistory.push({role:'user',content:text});
  addMsg('user',text);
  pending=true;
  var t0=performance.now();
  showTyping();
  try{
    console.log('[widget] sending to',CHAT_URL,'messages:',history.length);
    var r=await fetch(CHAT_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:chatHistory,sessionId:SESSION_ID})});
    console.log('[widget] response status:',r.status);
    var raw=await r.text();
    console.log('[widget] raw response:',raw);
    var data;try{data=JSON.parse(raw)}catch(pe){throw new Error('Server returned non-JSON ('+r.status+'): '+raw.slice(0,200))}
    if(!r.ok)throw new Error(data.error||JSON.stringify(data));
    var content=data.content;
    if(!content)throw new Error('Empty response from server');
    var dt=((performance.now()-t0)/1000).toFixed(2)+'s';
    chatHistory.push({role:'assistant',content:content});
    hideTyping();addMsg('agent',content,new Date(),dt);
  }catch(e){
    console.error('[widget] error:',e);
    var dt=((performance.now()-t0)/1000).toFixed(2)+'s';
    hideTyping();addMsg('error',e.message||String(e)||'Unknown error',new Date(),dt);
    chatHistory.pop();
  }
  pending=false;
}
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors * file: data:;");
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}
