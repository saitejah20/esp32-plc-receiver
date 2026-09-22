/*
   Mini ThingSpeak v2 - self-hosted IoT channel logging + live dashboards
   NOW WITH ACCOUNTS: each person signs up, logs in, and only sees their
   own channels. Channel dashboards stay viewable by their owner only.

   ESP32 posting data (/update?api_key=...) does NOT need login - it
   authenticates with the channel's own API key, same as real ThingSpeak.
*/

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

const USERS_FILE = path.join(__dirname, 'users.json');
const DB_FILE = path.join(__dirname, 'channels.json');
const HISTORY_LIMIT = 500;

// ---------------- JSON-file storage ----------------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2)); }
function saveChannels(c) { fs.writeFileSync(DB_FILE, JSON.stringify(c, null, 2)); }

let users = loadJson(USERS_FILE, {});       // { username: { passwordHash } }
let channels = loadJson(DB_FILE, {});       // { channelId: { owner, name, apiKey, fieldNames, history } }

function genId() { return crypto.randomBytes(4).toString('hex'); }
function genApiKey() { return crypto.randomBytes(12).toString('hex'); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:system-ui,sans-serif;background:#14181d;color:#e7ebef;padding:24px;max-width:800px;margin:0 auto;}
  h1{color:#f0a020;} a{color:#2dd4bf;text-decoration:none;}
  table{width:100%;border-collapse:collapse;margin-top:16px;}
  td,th{padding:8px;border-bottom:1px solid #2f3944;text-align:left;font-size:13px;}
  input,button{padding:8px;border-radius:5px;border:1px solid #2f3944;background:#232a32;color:#e7ebef;margin-top:6px;}
  button{background:#f0a020;color:#1a1200;font-weight:600;cursor:pointer;border:none;}
  .card{background:#1c2229;border:1px solid #2f3944;border-radius:8px;padding:18px;margin-top:16px;}
  code{background:#001a0a;color:#3f3;padding:2px 6px;border-radius:3px;font-size:11px;}
  .topbar{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#8a97a3;}
  .error{color:#e24b4a;font-size:13px;margin-top:8px;}
</style></head>
<body>${body}</body></html>`;
}

// ---------------- Auth middleware ----------------
function requireLogin(req, res, next) {
  if (!req.session.username) return res.redirect('/login');
  next();
}

// ---------------- Signup ----------------
app.get('/signup', (req, res) => {
  res.send(pageShell('Sign Up', `
    <h1>Create Account</h1>
    <div class="card">
      <form method="POST" action="/signup">
        <div>Username: <input name="username" required></div>
        <div>Password: <input name="password" type="password" required></div>
        <button type="submit">Sign Up</button>
      </form>
      <p style="margin-top:14px;">Already have an account? <a href="/login">Log in</a></p>
      ${req.query.error ? `<div class="error">${escapeHtml(req.query.error)}</div>` : ''}
    </div>
  `));
});

app.post('/signup', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!username || !password) return res.redirect('/signup?error=Username and password required');
  if (users[username]) return res.redirect('/signup?error=Username already taken');

  const passwordHash = await bcrypt.hash(password, 10);
  users[username] = { passwordHash };
  saveUsers(users);
  req.session.username = username;
  res.redirect('/');
});

// ---------------- Login ----------------
app.get('/login', (req, res) => {
  res.send(pageShell('Log In', `
    <h1>Log In</h1>
    <div class="card">
      <form method="POST" action="/login">
        <div>Username: <input name="username" required></div>
        <div>Password: <input name="password" type="password" required></div>
        <button type="submit">Log In</button>
      </form>
      <p style="margin-top:14px;">No account yet? <a href="/signup">Sign up</a></p>
      ${req.query.error ? `<div class="error">${escapeHtml(req.query.error)}</div>` : ''}
    </div>
  `));
});

app.post('/login', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const user = users[username];
  if (!user) return res.redirect('/login?error=Invalid username or password');
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.redirect('/login?error=Invalid username or password');
  req.session.username = username;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------- Home: list only MY channels ----------------
app.get('/', requireLogin, (req, res) => {
  const mine = Object.entries(channels).filter(([id, ch]) => ch.owner === req.session.username);
  const rows = mine.map(([id, ch]) =>
    `<tr><td><a href="/channels/${id}">${escapeHtml(ch.name)}</a></td><td>${ch.fieldNames.length} fields</td><td>${ch.history.length} points</td><td><code>${ch.apiKey}</code></td></tr>`
  ).join('');

  res.send(pageShell('Mini ThingSpeak', `
    <div class="topbar">
      <div>Logged in as <b>${escapeHtml(req.session.username)}</b></div>
      <a href="/logout">Log out</a>
    </div>
    <h1>My Channels</h1>
    <div class="card">
      <h3>Create a new channel</h3>
      <form method="POST" action="/create">
        <div>Channel name: <input name="name" required placeholder="PLC Panel"></div>
        <div>Field names (comma separated): <input name="fields" required placeholder="Temp,Pump,Pressure" style="width:280px;"></div>
        <button type="submit">Create Channel</button>
      </form>
    </div>
    <table>
      <tr><th>Channel</th><th>Fields</th><th>Points</th><th>Write API Key</th></tr>
      ${rows || '<tr><td colspan="4">No channels yet - create one above</td></tr>'}
    </table>
  `));
});

// ---------------- Create a channel (owned by the logged-in user) ----------------
app.post('/create', requireLogin, (req, res) => {
  const name = (req.body.name || 'Unnamed Channel').trim();
  const fieldNames = (req.body.fields || 'field1')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
  const id = genId();
  channels[id] = { owner: req.session.username, name, apiKey: genApiKey(), fieldNames, history: [], layout: null };
  saveChannels(channels);
  res.redirect('/channels/' + id);
});

// ---------------- Save SCADA layout (owner only) ----------------
app.post('/channels/:id/layout', requireLogin, (req, res) => {
  const ch = channels[req.params.id];
  if (!ch) return res.status(404).json({ error: 'not found' });
  if (ch.owner !== req.session.username) return res.status(403).json({ error: 'not your channel' });
  ch.layout = req.body;
  saveChannels(channels);
  res.json({ ok: true });
});

// ---------------- SCADA layout editor page (owner only) ----------------
app.get('/channels/:id/edit', requireLogin, (req, res) => {
  const ch = channels[req.params.id];
  if (!ch) return res.status(404).send('Channel not found');
  if (ch.owner !== req.session.username) return res.status(403).send('This is not your channel');

  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Edit Layout - ${escapeHtml(ch.name)}</title>
<style>
  :root{--bg:#14181d;--panel:#1c2229;--panel2:#232a32;--line:#2f3944;--text:#e7ebef;--sub:#8a97a3;--amber:#f0a020;--teal:#2dd4bf;--danger:#e24b4a;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;}
  .app{display:grid;grid-template-columns:170px 1fr 250px;grid-template-rows:auto auto 1fr;height:100vh;}
  .topbar{grid-column:1/4;background:var(--panel);border-bottom:1px solid var(--line);padding:8px 14px;display:flex;gap:10px;align-items:center;font-size:12px;}
  .topbar a{color:var(--teal);text-decoration:none;}
  .tabs{grid-column:1/4;display:flex;gap:4px;padding:6px 8px;background:var(--panel);border-bottom:1px solid var(--line);}
  .stab{background:var(--panel2);border:1px solid var(--line);border-radius:4px 4px 0 0;padding:5px 12px;font-size:11px;cursor:pointer;display:flex;gap:6px;align-items:center;}
  .stab.active{background:#412402;border-color:var(--amber);color:var(--amber);}
  .stabdel{color:var(--sub);}
  .stabadd{color:var(--teal);border-style:dashed;}
  .palette{background:var(--panel);border-right:1px solid var(--line);padding:10px;overflow-y:auto;}
  .ptile{background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:8px;margin-bottom:6px;cursor:grab;font-size:11px;text-align:center;}
  .canvas{position:relative;overflow:auto;background:#10141a;}
  .canvas-inner{position:relative;width:1000px;height:600px;}
  .w{position:absolute;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:6px;cursor:move;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;font-size:11px;}
  .w.selected{border-color:var(--amber);}
  .props{background:var(--panel);border-left:1px solid var(--line);padding:12px;overflow-y:auto;font-size:12px;}
  .props label{display:block;font-size:10px;color:var(--sub);margin:8px 0 3px;}
  .props input,.props select{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);padding:5px;border-radius:4px;}
  .btn{background:var(--amber);color:#1a1200;border:none;padding:6px 12px;border-radius:4px;font-weight:600;cursor:pointer;font-size:12px;}
  .delbtn{background:var(--danger);color:#fff;border:none;padding:6px;border-radius:4px;width:100%;margin-top:10px;cursor:pointer;}
</style></head>
<body>
<div class="app">
  <div class="topbar"><a href="/channels/${req.params.id}">&larr; Back to dashboard</a><div style="flex:1"></div><button class="btn" id="save-btn">Save Layout</button></div>
  <div class="tabs" id="screenTabs"></div>
  <div class="palette">
    <div class="ptile" draggable="true" data-type="value">Value</div>
    <div class="ptile" draggable="true" data-type="gauge">Gauge</div>
    <div class="ptile" draggable="true" data-type="lamp">Status Lamp</div>
    <div class="ptile" draggable="true" data-type="alarm">Alarm Card</div>
    <div class="ptile" draggable="true" data-type="label">Text Label</div>
    <div class="ptile" draggable="true" data-type="gotoscreen">Goto Screen</div>
  </div>
  <div class="canvas" id="canvas"><div class="canvas-inner" id="canvasInner"></div></div>
  <div class="props" id="props">Select a widget to edit it</div>
</div>
<script>
const FIELD_NAMES = ${JSON.stringify(ch.fieldNames)};
const EXISTING_LAYOUT = ${JSON.stringify(ch.layout)};
const DW=1000, DH=600;
let screens = (EXISTING_LAYOUT && EXISTING_LAYOUT.screens && EXISTING_LAYOUT.screens.length) ? EXISTING_LAYOUT.screens : [{id:1,name:'Main',widgets:[]}];
let currentScreenId = screens[0].id;
let idCounter = 1; screens.forEach(s=>s.widgets.forEach(w=>{ if(w.id>=idCounter) idCounter=w.id+1; }));
let screenIdCounter = Math.max(...screens.map(s=>s.id))+1;
let widgets = screens[0].widgets;
let selectedId = null;
const canvasInner = document.getElementById('canvasInner');
const props = document.getElementById('props');

function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function currentScreen(){ return screens.find(s=>s.id===currentScreenId); }
function switchScreen(id){ currentScreenId=id; widgets=currentScreen().widgets; selectedId=null; render(); renderTabs(); props.innerHTML='Select a widget to edit it'; }
function addScreen(){ const s={id:screenIdCounter++,name:'Screen '+screens.length,widgets:[]}; screens.push(s); switchScreen(s.id); }
function deleteScreen(id){ if(screens.length<=1){alert('At least one screen required');return;} if(!confirm('Delete this screen?'))return; screens=screens.filter(s=>s.id!==id); if(currentScreenId===id) switchScreen(screens[0].id); else renderTabs(); }
function renderTabs(){
  const bar=document.getElementById('screenTabs'); bar.innerHTML='';
  screens.forEach(s=>{
    const t=document.createElement('div'); t.className='stab'+(s.id===currentScreenId?' active':'');
    t.innerHTML = '<span>'+esc(s.name)+'</span><span class="stabdel">&times;</span>';
    t.firstChild.onclick=()=>switchScreen(s.id);
    t.firstChild.ondblclick=()=>{ const nn=prompt('Screen name:',s.name); if(nn) s.name=nn; renderTabs(); };
    t.lastChild.onclick=(e)=>{ e.stopPropagation(); deleteScreen(s.id); };
    bar.appendChild(t);
  });
  const add=document.createElement('div'); add.className='stab stabadd'; add.textContent='+ Add Screen'; add.onclick=addScreen;
  bar.appendChild(add);
}

document.querySelectorAll('.ptile').forEach(t=>t.addEventListener('dragstart', e=>e.dataTransfer.setData('type', t.dataset.type)));
const canvasOuter=document.getElementById('canvas');
canvasOuter.addEventListener('dragover', e=>e.preventDefault());
canvasOuter.addEventListener('drop', e=>{
  e.preventDefault();
  const type=e.dataTransfer.getData('type'); if(!type) return;
  const rect=canvasInner.getBoundingClientRect();
  addWidget(type, Math.max(0,e.clientX-rect.left-60), Math.max(0,e.clientY-rect.top-25));
});
function addWidget(type,x,y){
  const w={id:idCounter++,type,field:FIELD_NAMES.length?'field1':'',label:type==='label'?'Note':(type==='gotoscreen'?'Go to Screen':FIELD_NAMES[0]||'Value'),
    min:0,max:100,threshold:0.5,color:'#f0a020',fontSize:16,width:140,height:90,targetScreenId:screens.find(s=>s.id!==currentScreenId)?.id||currentScreenId,x,y};
  widgets.push(w); render(); selectWidget(w.id);
}
function widgetHtml(w){
  if(w.type==='label') return '<div style="font-weight:600;color:'+w.color+';">'+esc(w.label)+'</div>';
  if(w.type==='gotoscreen') return '<div>'+esc(w.label)+'</div><div style="font-size:9px;color:var(--sub);">&rarr; screen '+w.targetScreenId+'</div>';
  let head = '<div style="font-size:10px;color:var(--sub);">'+esc(w.label)+'</div>';
  if(w.type==='value') return head+'<div style="font-size:18px;font-weight:700;color:'+w.color+';">--</div>';
  if(w.type==='gauge') return head+'<div style="width:80%;height:6px;background:var(--panel);border-radius:3px;margin-top:6px;"><div style="width:40%;height:100%;background:'+w.color+';"></div></div><div style="font-size:9px;color:var(--sub);">'+w.min+'-'+w.max+'</div>';
  if(w.type==='lamp') return head+'<div style="width:14px;height:14px;border-radius:50%;background:#555;margin-top:6px;"></div>';
  if(w.type==='alarm') return head+'<div style="font-size:12px;color:'+w.color+';margin-top:4px;">Normal</div>';
  return head;
}
function render(){
  canvasInner.querySelectorAll('.w').forEach(el=>el.remove());
  widgets.forEach(w=>{
    const el=document.createElement('div');
    el.className='w'+(w.id===selectedId?' selected':'');
    el.style.left=w.x+'px'; el.style.top=w.y+'px'; el.style.width=w.width+'px'; el.style.height=w.height+'px';
    el.innerHTML=widgetHtml(w);
    el.addEventListener('mousedown', startDrag(w));
    el.addEventListener('click', ()=>selectWidget(w.id));
    canvasInner.appendChild(el);
  });
}
function startDrag(w){
  return function(e){
    selectWidget(w.id);
    const sx=e.clientX, sy=e.clientY, ox=w.x, oy=w.y;
    function move(ev){ w.x=Math.max(0,ox+(ev.clientX-sx)); w.y=Math.max(0,oy+(ev.clientY-sy)); render(); selectWidget(w.id,false); }
    function up(){ document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); }
    document.addEventListener('mousemove',move); document.addEventListener('mouseup',up);
  };
}
function selectWidget(id, rerender=true){
  selectedId=id;
  if(rerender) render(); else document.querySelectorAll('.w').forEach(el=>el.classList.remove('selected'));
  const w=widgets.find(w=>w.id===id); if(!w){ props.innerHTML='Select a widget to edit it'; return; }
  let extra='';
  if(w.type!=='label' && w.type!=='gotoscreen'){
    extra += '<label>Field</label><select id="p-field">'+FIELD_NAMES.map(f=>'<option value="'+esc(f)+'"'+(f===w.field?' selected':'')+'>'+esc(f)+'</option>').join('')+'</select>';
  }
  if(w.type==='gauge'){ extra += '<label>Min</label><input id="p-min" type="number" value="'+w.min+'"><label>Max</label><input id="p-max" type="number" value="'+w.max+'">'; }
  if(w.type==='lamp' || w.type==='alarm'){ extra += '<label>Threshold (ON/alarm if value >= this)</label><input id="p-thresh" type="number" value="'+w.threshold+'">'; }
  if(w.type==='gotoscreen'){ extra += '<label>Target screen</label><select id="p-target">'+screens.map(s=>'<option value="'+s.id+'"'+(s.id===w.targetScreenId?' selected':'')+'>'+esc(s.name)+'</option>').join('')+'</select>'; }
  extra += '<label>Width</label><input id="p-width" type="number" value="'+w.width+'"><label>Height</label><input id="p-height" type="number" value="'+w.height+'">';
  extra += '<label>Color</label><input id="p-color" type="color" value="'+w.color+'">';
  props.innerHTML = '<label>Label</label><input id="p-label" value="'+esc(w.label)+'">'+extra+'<button class="delbtn" id="p-del">Delete widget</button>';
  const bind=(id,key,parse)=>{ const el=document.getElementById(id); if(el) el.oninput=e=>{ w[key]=parse?parse(e.target.value):e.target.value; render(); selectWidget(w.id,false); }; };
  bind('p-label','label'); bind('p-field','field'); bind('p-min','min',v=>parseFloat(v)||0); bind('p-max','max',v=>parseFloat(v)||100);
  bind('p-thresh','threshold',v=>parseFloat(v)||0); bind('p-target','targetScreenId',v=>parseInt(v));
  bind('p-width','width',v=>parseInt(v)||60); bind('p-height','height',v=>parseInt(v)||40); bind('p-color','color');
  document.getElementById('p-del').onclick=()=>{ widgets=widgets.filter(x=>x.id!==w.id); currentScreen().widgets=widgets; selectedId=null; render(); props.innerHTML='Select a widget to edit it'; };
}
document.getElementById('save-btn').addEventListener('click', async ()=>{
  const res = await fetch('/channels/${req.params.id}/layout', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({designW:DW,designH:DH,screens:screens}) });
  const json = await res.json();
  alert(json.ok ? 'Layout saved!' : 'Failed to save');
});
renderTabs(); render();
</script>
</body></html>`);
});


app.all('/update', (req, res) => {
  const params = { ...req.query, ...req.body };
  const apiKey = params.api_key;
  const found = Object.entries(channels).find(([id, c]) => c.apiKey === apiKey);
  if (!found) return res.status(401).send('0');

  const [id, channel] = found;
  const point = { t: Date.now() };
  channel.fieldNames.forEach((fname, i) => {
    const key = 'field' + (i + 1);
    if (params[key] !== undefined) point[key] = parseFloat(params[key]);
  });
  channel.history.push(point);
  if (channel.history.length > HISTORY_LIMIT) channel.history.shift();
  saveChannels(channels);
  res.send(String(channel.history.length));
});

// ---------------- Channel data as JSON (owner only) ----------------
app.get('/channels/:id/data', requireLogin, (req, res) => {
  const ch = channels[req.params.id];
  if (!ch) return res.status(404).json({ error: 'not found' });
  if (ch.owner !== req.session.username) return res.status(403).json({ error: 'not your channel' });
  res.json({ name: ch.name, fieldNames: ch.fieldNames, history: ch.history });
});

// ---------------- Live dashboard for a channel (owner only) ----------------
app.get('/channels/:id', requireLogin, (req, res) => {
  const ch = channels[req.params.id];
  if (!ch) return res.status(404).send('Channel not found');
  if (ch.owner !== req.session.username) return res.status(403).send('This is not your channel');

  const hasLayout = ch.layout && ch.layout.screens && ch.layout.screens.some(s => s.widgets && s.widgets.length);
  if (hasLayout) return res.send(scadaDashboard(req.params.id, ch));
  res.send(plainDashboard(req.params.id, ch));
});

function fieldIndex(ch, fieldName) {
  const i = ch.fieldNames.indexOf(fieldName);
  return i >= 0 ? i + 1 : 1; // 'field1' etc, default field1 if not found
}

function scadaWidgetHtml(w, ch, DW, DH) {
  const left = (w.x / DW * 100).toFixed(2), top = (w.y / DH * 100).toFixed(2);
  const ww = (w.width / DW * 100).toFixed(2), hh = (w.height / DH * 100).toFixed(2);
  const box = `left:${left}%;top:${top}%;width:${ww}%;height:${hh}%;`;
  const fidx = w.field ? fieldIndex(ch, w.field) : 1;
  const label = escapeHtml(w.label || '');
  const color = w.color || '#f0a020';

  if (w.type === 'label') {
    return `<div class="w" style="${box}color:${color};border:none;background:transparent;"><div style="font-weight:600;font-size:${w.fontSize}px;">${label}</div></div>`;
  }
  if (w.type === 'gotoscreen') {
    return `<div class="w" style="${box}"><div class="lbl">${label}</div><button onclick="gotoScreen(${w.targetScreenId})">Go</button></div>`;
  }
  if (w.type === 'gauge') {
    return `<div class="w" style="${box}"><div class="lbl">${label} (${w.min}-${w.max})</div><div style="width:90%;height:10%;background:#14181d;border-radius:4px;overflow:hidden;margin-top:6%;"><div id="bar${w.id}" style="width:0%;height:100%;background:${color};transition:width .3s;"></div></div><div class="val" data-field="${fidx}" data-mode="gauge" data-min="${w.min}" data-max="${w.max}" data-bar="bar${w.id}" style="color:${color};">--</div></div>`;
  }
  if (w.type === 'lamp') {
    return `<div class="w" style="${box}flex-direction:row;gap:8px;"><span class="lamp" data-field="${fidx}" data-mode="lamp" data-thresh="${w.threshold}"></span><span class="lbl">${label}</span></div>`;
  }
  if (w.type === 'alarm') {
    return `<div class="w" id="card${w.id}" style="${box}"><div class="lbl">${label}</div><div class="val" data-field="${fidx}" data-mode="alarm" data-thresh="${w.threshold}" data-card="card${w.id}" style="color:${color};">Normal</div></div>`;
  }
  // default: value
  return `<div class="w" style="${box}"><div class="lbl">${label}</div><div class="val" data-field="${fidx}" data-mode="plain" style="color:${color};font-size:${w.fontSize}px;">--</div></div>`;
}

function scadaDashboard(id, ch) {
  const DW = ch.layout.designW || 1000, DH = ch.layout.designH || 600;
  const screens = ch.layout.screens;
  const tabsHtml = screens.map((s, i) => `<div class="stab${i === 0 ? ' active' : ''}" onclick="gotoScreen(${s.id})" id="tabbtn${s.id}">${escapeHtml(s.name)}</div>`).join('');
  const screensHtml = screens.map((s, i) => {
    const wh = s.widgets.map(w => scadaWidgetHtml(w, ch, DW, DH)).join('');
    return `<div class="screen" id="screen${s.id}" style="display:${i === 0 ? 'block' : 'none'};"><div class="stage">${wh}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(ch.name)}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:system-ui,sans-serif;background:#14181d;color:#e7ebef;margin:0;padding:16px;}
  a{color:#2dd4bf;font-size:12px;text-decoration:none;}
  .tabs{display:flex;gap:6px;margin:12px 0;flex-wrap:wrap;max-width:${DW}px;margin-left:auto;margin-right:auto;}
  .stab{background:#232a32;border:1px solid #2f3944;border-radius:5px 5px 0 0;padding:6px 14px;font-size:12px;cursor:pointer;}
  .stab.active{background:#412402;border-color:#f0a020;color:#f0a020;}
  .stage{position:relative;width:100%;max-width:${DW}px;aspect-ratio:${DW}/${DH};margin:0 auto;container-type:inline-size;}
  .w{position:absolute;background:#232a32;border:1px solid #2f3944;border-radius:6px;padding:2% 3%;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;transition:background .3s,border-color .3s;}
  .lbl{font-size:clamp(9px,2.4cqw,13px);color:#8a97a3;}
  .val{font-weight:700;font-size:clamp(12px,2.4cqw,20px);}
  .lamp{width:14px;height:14px;border-radius:50%;background:#555;flex-shrink:0;}
  button{padding:5px 12px;border-radius:4px;border:1px solid #2f3944;background:#1c2229;color:#e7ebef;cursor:pointer;}
  .status{font-size:11px;color:#8a97a3;text-align:center;margin-top:14px;}
</style></head>
<body>
  <a href="/">&larr; All my channels</a> &nbsp;|&nbsp; <a href="/channels/${id}/edit">Edit Layout</a>
  <div class="tabs">${tabsHtml}</div>
  ${screensHtml}
  <div class="status" id="status">Loading...</div>
<script>
function gotoScreen(id){
  document.querySelectorAll('.screen').forEach(function(s){s.style.display='none';});
  document.querySelectorAll('.stab').forEach(function(t){t.classList.remove('active');});
  var t=document.getElementById('screen'+id); if(t)t.style.display='block';
  var tb=document.getElementById('tabbtn'+id); if(tb)tb.classList.add('active');
}
async function refresh(){
  try{
    const res = await fetch('/channels/${id}/data');
    const json = await res.json();
    const hist = json.history || [];
    if(!hist.length){ document.getElementById('status').textContent = 'No data received yet'; return; }
    const latest = hist[hist.length-1];
    document.querySelectorAll('[data-field]').forEach(function(el){
      const fkey = 'field'+el.getAttribute('data-field');
      const v = latest[fkey];
      if(v === undefined) return;
      const mode = el.getAttribute('data-mode');
      if(mode==='plain'){ el.textContent = v; }
      else if(mode==='gauge'){
        el.textContent = v;
        const min=parseFloat(el.getAttribute('data-min')), max=parseFloat(el.getAttribute('data-max'));
        const bar = document.getElementById(el.getAttribute('data-bar'));
        if(bar){ const pct = Math.max(0,Math.min(100,(v-min)/(max-min)*100)); bar.style.width = pct+'%'; }
      }
      else if(mode==='lamp'){
        const th = parseFloat(el.getAttribute('data-thresh'));
        el.style.background = (v>=th) ? '#0f6e56' : '#555';
      }
      else if(mode==='alarm'){
        const th = parseFloat(el.getAttribute('data-thresh'));
        const on = v>=th;
        el.textContent = on ? 'ALARM' : 'Normal';
        const card = document.getElementById(el.getAttribute('data-card'));
        if(card){ card.style.background = on ? '#4a1b0c' : ''; card.style.borderColor = on ? '#e24b4a' : ''; }
      }
    });
    const secsAgo = Math.round((Date.now()-latest.t)/1000);
    document.getElementById('status').textContent = 'Last update: '+secsAgo+'s ago';
  }catch(e){ document.getElementById('status').textContent = 'Connection error'; }
}
setInterval(refresh, 3000);
refresh();
</script>
</body></html>`;
}

function plainDashboard(id, ch) {
  const cardsHtml = ch.fieldNames.map((fname, i) =>
    `<div class="card"><div class="lbl">${escapeHtml(fname)}</div><div class="val" id="v${i + 1}">--</div><canvas id="c${i + 1}" width="400" height="120"></canvas></div>`
  ).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(ch.name)}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:system-ui,sans-serif;background:#14181d;color:#e7ebef;padding:20px;margin:0;}
  h1{color:#f0a020;font-size:1.3em;}
  a{color:#2dd4bf;font-size:12px;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-top:16px;}
  .card{background:#232a32;border:1px solid #2f3944;border-radius:8px;padding:14px;}
  .lbl{font-size:12px;color:#8a97a3;}
  .val{font-size:26px;font-weight:700;color:#f0a020;margin:4px 0 10px;}
  canvas{width:100%;height:100px;background:#14181d;border-radius:4px;}
  .status{font-size:11px;color:#8a97a3;margin-top:16px;}
  .writekey{background:#1c2229;border:1px solid #2f3944;border-radius:6px;padding:10px;margin-top:10px;font-size:12px;word-break:break-all;}
  code{background:#001a0a;color:#3f3;padding:2px 6px;border-radius:3px;}
  .banner{background:#1c2229;border:1px solid #2dd4bf;border-radius:6px;padding:10px;margin-top:12px;font-size:13px;}
</style></head>
<body>
  <a href="/">&larr; All my channels</a>
  <h1>${escapeHtml(ch.name)}</h1>
  <div class="writekey">POST to this URL from your ESP32: <br><code>https://YOUR-SERVER/update?api_key=${ch.apiKey}&field1=VALUE&field2=VALUE</code></div>
  <div class="banner">Want gauges, switches, alarms, and multiple screens instead of plain numbers? <a href="/channels/${id}/edit">Design a SCADA layout &rarr;</a></div>
  <div class="grid">${cardsHtml}</div>
  <div class="status" id="status">Loading...</div>
<script>
async function refresh(){
  try{
    const res = await fetch('/channels/${id}/data');
    const json = await res.json();
    const hist = json.history || [];
    json.fieldNames.forEach(function(name, idx){
      const key = 'field'+(idx+1);
      const vals = hist.map(function(p){ return p[key]; }).filter(function(v){ return v!==undefined; });
      const valEl = document.getElementById('v'+(idx+1));
      if(valEl) valEl.textContent = vals.length ? vals[vals.length-1] : '--';
      const cv = document.getElementById('c'+(idx+1));
      if(cv && vals.length>1) drawChart(cv, vals);
    });
    const status = document.getElementById('status');
    if(hist.length){
      const secsAgo = Math.round((Date.now()-hist[hist.length-1].t)/1000);
      status.textContent = hist.length+' points logged. Last update: '+secsAgo+'s ago';
    } else {
      status.textContent = 'No data received yet on this channel';
    }
  }catch(e){ document.getElementById('status').textContent = 'Connection error'; }
}
function drawChart(cv, data){
  if(!cv.width || cv.width!=cv.clientWidth){ cv.width=cv.clientWidth; cv.height=cv.clientHeight; }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0,0,cv.width,cv.height);
  const mn = Math.min.apply(null,data), mx = Math.max.apply(null,data);
  const range = (mx===mn) ? 1 : (mx-mn);
  ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 2; ctx.beginPath();
  data.forEach(function(v,i){
    const x = i/(data.length-1)*cv.width;
    const y = cv.height - ((v-mn)/range)*cv.height;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
}
setInterval(refresh, 3000);
refresh();
</script>
</body></html>`;
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('Mini ThingSpeak v2 running on port ' + PORT);
});
