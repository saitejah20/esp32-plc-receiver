/*
   ESP32 PLC Panel - Remote Receiver Server (v4 - MULTI-USER)
   - Each person SIGNS UP their own account (username/password)
   - That SAME username/password is what you put in the Panel Builder's
     "Remote User"/"Remote Pass" fields - your ESP32 authenticates as
     you, and its data/design/commands are completely isolated from
     everyone else's account on this same server.
   - Browser access uses the same login (HTTP Basic Auth popup).

   REMOTE CONTROL: since each ESP32 sits behind its own router, the
   browser can't reach it directly. Instead:
     1. Browser clicks a switch -> POST /command (queued for that user)
     2. That user's ESP32 polls GET /commands every couple seconds
     3. ESP32 executes it via Modbus, the queue then clears
*/

const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const USERS_FILE = path.join(__dirname, 'users.json');
const HISTORY_LIMIT = 500;

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

// users: { username: { passwordHash, latestData, lastUpdateTime, panelDesign,
//                       pendingCommands, history } }
let users = loadJson(USERS_FILE, {});

function freshUserData() {
  return { latestData: {}, lastUpdateTime: null, panelDesign: null, pendingCommands: [], history: [] };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Signup (public, no auth needed) ----------------
app.get('/signup', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign Up - PLC Remote Panel</title>
<style>
  :root{--bg:#14181d;--panel:#1c2229;--panel2:#232a32;--line:#2f3944;--text:#e7ebef;--sub:#8a97a3;--amber:#f0a020;--teal:#2dd4bf;--danger:#e24b4a;}
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:32px;width:100%;max-width:360px;}
  .badge{font-family:monospace;font-size:11px;letter-spacing:.12em;color:var(--teal);text-transform:uppercase;text-align:center;margin-bottom:6px;}
  h2{text-align:center;margin:0 0 8px;font-size:22px;}
  .sub{color:var(--sub);font-size:12px;text-align:center;line-height:1.5;margin-bottom:24px;}
  label{display:block;font-size:11px;color:var(--sub);margin:12px 0 4px;}
  input{width:100%;padding:10px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-size:14px;}
  input:focus{outline:1px solid var(--teal);}
  button{width:100%;margin-top:20px;padding:11px;border-radius:6px;border:none;background:var(--amber);color:#1a1200;font-weight:600;font-size:14px;cursor:pointer;}
  button:hover{filter:brightness(1.1);}
  .error{color:var(--danger);font-size:12px;margin-top:12px;text-align:center;}
  .footlink{text-align:center;font-size:12px;color:var(--sub);margin-top:20px;}
  a{color:var(--teal);text-decoration:none;}
</style></head>
<body>
  <div class="card">
    <div class="badge">PLC Remote Panel</div>
    <h2>Create Your Account</h2>
    <p class="sub">This username/password becomes both your dashboard login and your ESP32's "Remote User"/"Remote Pass" in the Panel Builder tool.</p>
    <form method="POST" action="/signup">
      <label>Username</label>
      <input name="username" required autofocus>
      <label>Password</label>
      <input name="password" type="password" required>
      <button type="submit">Sign Up</button>
    </form>
    ${req.query.error ? `<div class="error">${escapeHtml(req.query.error)}</div>` : ''}
    <div class="footlink">Already have an account? <a href="/dashboard">Log in</a></div>
  </div>
</body></html>`);
});

app.post('/signup', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  if (!username || !password) return res.redirect('/signup?error=Username and password required');
  if (users[username]) return res.redirect('/signup?error=Username already taken');

  const passwordHash = await bcrypt.hash(password, 10);
  users[username] = { passwordHash, ...freshUserData() };
  saveUsers();
  res.send(`<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#14181d;color:#e7ebef;padding:40px;text-align:center;">
  <h2>Account created!</h2>
  <p>Username: <b>${escapeHtml(username)}</b></p>
  <p>Use this same username/password in the Panel Builder's "Remote User"/"Remote Pass" fields, and to log in to <a href="/dashboard" style="color:#2dd4bf;">your dashboard</a>.</p>
  </body></html>`);
});

// ---------------- Public landing page (no auth) ----------------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PLC Remote Panel</title>
<style>
  :root{--bg:#14181d;--panel:#1c2229;--panel2:#232a32;--line:#2f3944;--text:#e7ebef;--sub:#8a97a3;--amber:#f0a020;--teal:#2dd4bf;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;}
  .badge{font-family:monospace;font-size:11px;letter-spacing:.15em;color:var(--teal);text-transform:uppercase;margin-bottom:10px;}
  h1{font-size:clamp(28px,5vw,44px);margin:0 0 12px;background:linear-gradient(90deg,var(--amber),var(--teal));-webkit-background-clip:text;background-clip:text;color:transparent;}
  .tagline{color:var(--sub);font-size:15px;max-width:480px;margin:0 0 32px;line-height:1.5;}
  .features{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;max-width:640px;margin-bottom:36px;}
  .feature{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 18px;font-size:12px;color:var(--sub);width:140px;}
  .feature .ico{font-size:20px;margin-bottom:6px;display:block;}
  .actions{display:flex;gap:14px;}
  .btn{padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;cursor:pointer;border:none;transition:filter .15s;}
  .btn:hover{filter:brightness(1.12);}
  .btn-primary{background:var(--amber);color:#1a1200;}
  .btn-secondary{background:var(--panel2);color:var(--text);border:1px solid var(--line);}
  .footnote{margin-top:40px;font-size:11px;color:#5b6672;}
</style></head>
<body>
  <div class="badge">Self-Hosted &middot; Multi-User</div>
  <h1>PLC Remote Panel</h1>
  <p class="tagline">Monitor and control your PLC from anywhere in the world. Each account gets its own private, styled SCADA dashboard fed live by your ESP32.</p>
  <div class="features">
    <div class="feature"><span class="ico">&#128225;</span>Live data from your ESP32, updated every few seconds</div>
    <div class="feature"><span class="ico">&#128737;</span>Private per-account dashboards, nobody sees your panel but you</div>
    <div class="feature"><span class="ico">&#128268;</span>Remote switches &amp; setpoints, not just read-only values</div>
  </div>
  <div class="actions">
    <a class="btn btn-primary" href="/signup">Sign Up</a>
    <a class="btn btn-secondary" href="/dashboard">Log In</a>
  </div>
  <div class="footnote">Logging in will prompt your browser for the username/password you signed up with.</div>
</body></html>`);
});

// ---------------- Basic Auth (protects everything else, identifies which user) ----------------
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const sep = decoded.indexOf(':');
    const username = decoded.slice(0, sep);
    const password = decoded.slice(sep + 1);
    const user = users[username];
    if (user) {
      bcrypt.compare(password, user.passwordHash).then(ok => {
        if (ok) { req.authUser = username; return next(); }
        return unauthorized(res);
      });
      return;
    }
  }
  return unauthorized(res);
});
function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="PLC Panel - use your account login"');
  res.status(401).send('Authentication required. No account? Visit /signup first.');
}

// ---------------- ESP32 <-> server data sync (scoped to req.authUser) ----------------
app.post('/data', (req, res) => {
  const u = users[req.authUser];
  u.latestData = req.body || {};
  u.lastUpdateTime = Date.now();
  u.history.push({ t: u.lastUpdateTime, ...u.latestData });
  if (u.history.length > HISTORY_LIMIT) u.history.shift();
  saveUsers();
  res.json({ ok: true });
});

app.get('/data', (req, res) => {
  const u = users[req.authUser];
  res.json({ data: u.latestData, lastUpdate: u.lastUpdateTime });
});

app.get('/history', (req, res) => {
  res.json(users[req.authUser].history);
});

app.get('/commands', (req, res) => {
  const u = users[req.authUser];
  const cmds = u.pendingCommands;
  u.pendingCommands = [];
  saveUsers();
  res.json(cmds);
});

// ---------------- Panel design (scoped to req.authUser) ----------------
app.post('/design', (req, res) => {
  const u = users[req.authUser];
  u.panelDesign = req.body;
  saveUsers();
  res.json({ ok: true, screens: (u.panelDesign.screens || []).length });
});
app.get('/design', (req, res) => {
  res.json(users[req.authUser].panelDesign || {});
});

app.get('/upload', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Upload Panel Design</title>
<style>body{font-family:system-ui,sans-serif;background:#14181d;color:#e7ebef;padding:40px;text-align:center;}
input,button{padding:10px;margin-top:16px;border-radius:6px;border:1px solid #2f3944;background:#232a32;color:#e7ebef;}
button{background:#f0a020;color:#1a1200;font-weight:600;cursor:pointer;border:none;}
#msg{margin-top:16px;color:#2dd4bf;} a{color:#2dd4bf;}</style></head>
<body>
  <h2>Upload panel_design.json</h2>
  <p>Logged in as <b>${escapeHtml(req.authUser)}</b>. Export this from the Panel Builder tool, then upload it here once.</p>
  <input type="file" id="file" accept=".json"><br>
  <button onclick="upload()">Upload</button>
  <div id="msg"></div>
  <p><a href="/dashboard">&larr; Back to dashboard</a></p>
<script>
async function upload(){
  const f = document.getElementById('file').files[0];
  if(!f){ document.getElementById('msg').textContent = 'Choose a file first'; return; }
  const text = await f.text();
  const res = await fetch('/design', { method:'POST', headers:{'Content-Type':'application/json'}, body:text });
  const json = await res.json();
  document.getElementById('msg').innerHTML = 'Uploaded! ' + json.screens + ' screen(s) loaded. <a href="/dashboard">Go to the dashboard</a>.';
}
</script>
</body></html>`);
});

// ---------------- Helpers ----------------
const DESIGN_W_DEFAULT = 1200, DESIGN_H_DEFAULT = 750;
function pct(v, total) { return (v / total * 100).toFixed(2); }
function parseCodes(text) {
  return String(text || '').split('\n').map(line => {
    const idx = line.indexOf(':');
    if (idx < 0) return null;
    const v = parseInt(line.slice(0, idx).trim());
    const t = line.slice(idx + 1).trim();
    if (isNaN(v) || !t) return null;
    return { val: v, text: t };
  }).filter(Boolean);
}
function findWidget(panelDesign, tagId) {
  if (!panelDesign) return null;
  for (const s of panelDesign.screens || []) {
    const w = s.widgets.find(w => String(w.id) === String(tagId));
    if (w) return w;
  }
  return null;
}
function isCoilType(t) {
  return t === 'coil' || t === 'lamp' || t === 'alarm' || t === 'bulb' || t === 'motor' || t === 'valve' || t === 'alarmbanner' || t === 'pipe' || t === 'heater' || t === 'fan';
}

// ---------------- Queue a control command (scoped to req.authUser) ----------------
app.post('/command', (req, res) => {
  const u = users[req.authUser];
  const { tagId, action, value } = req.body || {};
  const w = findWidget(u.panelDesign, tagId);
  if (!w) return res.status(404).json({ ok: false, error: 'Unknown tag' });

  if (action === 'on' || action === 'off') {
    if (!isCoilType(w.type)) return res.status(400).json({ ok: false, error: 'Not a coil-type widget' });
    u.pendingCommands.push({ type: 'coil', address: w.address, value: action === 'on' ? 1 : 0 });
  } else if (action === 'toggle') {
    if (!isCoilType(w.type)) return res.status(400).json({ ok: false, error: 'Not a coil-type widget' });
    const current = u.latestData[tagId] == 1 ? 1 : 0;
    u.pendingCommands.push({ type: 'coil', address: w.address, value: current ? 0 : 1 });
  } else if (action === 'set') {
    const v = parseInt(value);
    if (isNaN(v)) return res.status(400).json({ ok: false, error: 'Invalid value' });
    u.pendingCommands.push({ type: 'register', address: w.address, value: v });
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }
  saveUsers();
  res.json({ ok: true, queued: u.pendingCommands.length });
});

// ---------------- Widget rendering ----------------
function renderWidget(w, DW, DH) {
  const left = pct(w.x, DW), top = pct(w.y, DH), ww = pct(w.width, DW), hh = pct(w.height, DH);
  const boxStyle = `left:${left}%;top:${top}%;width:${ww}%;height:${hh}%;`;
  const color = w.color || '#f0a020';
  const fs = w.fontSize || 16;
  const label = escapeHtml(w.label || '');
  const comment = w.comment ? `<div class="cmt">${escapeHtml(w.comment)}</div>` : '';
  const valStyle = `color:${color};font-size:${fs}px;`;

  switch (w.type) {
    case 'label':
      return `<div class="w" style="${boxStyle}color:${color};border:none;background:transparent;"><div style="font-weight:600;font-size:${fs}px;">${label}</div>${comment}</div>`;
    case 'coil':
      return `<div class="w" id="card${w.id}" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="onoff" style="${valStyle}">--</div><div><button onclick="sendCmd(${w.id},'on')">ON</button><button onclick="sendCmd(${w.id},'off')">OFF</button></div>${comment}</div>`;
    case 'lamp':
      return `<div class="w" style="${boxStyle}flex-direction:row;gap:8px;"><span class="lamp" data-tag="${w.id}" data-mode="lamp"></span><span class="lbl">${label}</span>${comment}</div>`;
    case 'bulb':
      return `<div class="w" style="${boxStyle}color:${color};"><div class="bulb" data-tag="${w.id}" data-mode="bulb"></div><div class="lbl">${label}</div>${comment}</div>`;
    case 'alarm': case 'alarmbanner':
      return `<div class="w" id="card${w.id}" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="alarmtext" style="${valStyle}">--</div>${comment}</div>`;
    case 'alarmcode':
      return `<div class="w" id="card${w.id}" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="alarmcode" data-codes='${JSON.stringify(parseCodes(w.codesText)).replace(/'/g, "&#39;")}' style="${valStyle}">--</div>${comment}</div>`;
    case 'setpoint': case 'slider': case 'knob':
      return `<div class="w" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="plain" style="${valStyle}">--</div><div><input type="number" id="in${w.id}" style="width:70px;"><button onclick="sendSet(${w.id})">Set</button></div>${comment}</div>`;
    case 'clock':
      return `<div class="w" style="${boxStyle}"><div class="lbl">${label}</div><div class="val clock-live" style="${valStyle}">--:--:--</div>${comment}</div>`;
    case 'commstatus':
      return `<div class="w" style="${boxStyle}flex-direction:row;gap:8px;"><span class="lamp" data-tag="commOK" data-mode="lamp"></span><span class="lbl">${label}</span>${comment}</div>`;
    case 'gotoscreen':
      return `<div class="w" style="${boxStyle}"><div class="lbl">${label}</div><button onclick="gotoScreen(${w.targetScreenId})">Go</button>${comment}</div>`;
    default:
      return `<div class="w" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="plain" style="${valStyle}">--</div>${comment}</div>`;
  }
}

// ---------------- Dashboard (scoped to req.authUser) ----------------
app.get('/dashboard', (req, res) => {
  const u = users[req.authUser];
  if (!u.panelDesign || !u.panelDesign.screens || !u.panelDesign.screens.length) {
    return res.send(genericDashboard(req.authUser));
  }
  res.send(styledDashboard(req.authUser, u.panelDesign));
});

function genericDashboard(username) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PLC Remote Dashboard</title>
<style>
  body{font-family:system-ui,sans-serif;background:#14181d;color:#e7ebef;padding:20px;}
  h1{color:#f0a020;} a{color:#2dd4bf;}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;}
  .card{background:#232a32;border:1px solid #2f3944;border-radius:8px;padding:14px;}
  .card .k{font-size:11px;color:#8a97a3;} .card .v{font-size:22px;font-weight:700;color:#f0a020;}
</style></head>
<body>
  <h1>PLC Remote Dashboard</h1>
  <p>Logged in as <b>${escapeHtml(username)}</b>. No panel design uploaded yet - showing raw tag values. <a href="/upload">Upload your panel_design.json</a> to see your real styled panel with controls.</p>
  <div class="grid" id="grid"></div>
<script>
async function refresh(){
  const res = await fetch('/data'); const json = await res.json();
  const keys = Object.keys(json.data||{});
  document.getElementById('grid').innerHTML = keys.map(function(k){
    return '<div class="card"><div class="k">Tag '+k+'</div><div class="v">'+json.data[k]+'</div></div>';
  }).join('');
}
setInterval(refresh,2000); refresh();
</script>
</body></html>`;
}

function styledDashboard(username, design) {
  const DW = design.designW || DESIGN_W_DEFAULT;
  const DH = design.designH || DESIGN_H_DEFAULT;
  const screens = design.screens || [];

  const tabsHtml = screens.map((s, i) =>
    `<div class="stab${i === 0 ? ' active' : ''}" onclick="gotoScreen(${s.id})" id="tabbtn${s.id}">${escapeHtml(s.name)}</div>`
  ).join('');

  const screensHtml = screens.map((s, i) => {
    const widgetsHtml = s.widgets.map(w => renderWidget(w, DW, DH)).join('');
    return `<div class="screen" id="screen${s.id}" style="display:${i === 0 ? 'block' : 'none'};"><div class="stage">${widgetsHtml}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PLC Remote Dashboard</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:system-ui,sans-serif;background:#14181d;color:#e7ebef;margin:0;padding:16px;}
  .topbar{font-size:12px;color:#8a97a3;text-align:center;margin-bottom:10px;}
  .tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;max-width:${DW}px;margin-left:auto;margin-right:auto;}
  .stab{background:#232a32;border:1px solid #2f3944;border-radius:5px 5px 0 0;padding:6px 14px;font-size:12px;cursor:pointer;}
  .stab.active{background:#412402;border-color:#f0a020;color:#f0a020;}
  .stage{position:relative;width:100%;max-width:${DW}px;aspect-ratio:${DW}/${DH};margin:0 auto;container-type:inline-size;}
  .w{position:absolute;background:#232a32;border:1px solid #2f3944;border-radius:6px;padding:2% 3%;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;transition:background .3s,border-color .3s;}
  .lbl{font-size:clamp(9px,2.4cqw,15px);color:#8a97a3;}
  .cmt{font-size:clamp(7px,1.6cqw,11px);font-style:italic;color:#6b7784;margin-top:2px;}
  .val{font-weight:700;font-size:clamp(12px,2.4cqw,22px);}
  button{margin-top:6%;margin-right:4px;padding:5px 12px;border-radius:4px;border:1px solid #2f3944;background:#1c2229;color:#e7ebef;cursor:pointer;font-size:clamp(9px,1.6cqw,12px);}
  input[type=number]{width:60px;padding:4px;border-radius:4px;border:1px solid #2f3944;background:#1c2229;color:#e7ebef;}
  .lamp{width:14px;height:14px;border-radius:50%;flex-shrink:0;background:#555;}
  .bulb{width:50%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,#555,#333);margin:4% auto;}
  .bulb.on{box-shadow:0 0 20px 6px currentColor;}
  .status{font-size:11px;color:#8a97a3;text-align:center;margin-top:14px;}
  .status.stale{color:#e24b4a;}
  .toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#232a32;border:1px solid #2dd4bf;color:#2dd4bf;padding:8px 16px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .3s;pointer-events:none;}
  .toast.show{opacity:1;}
</style></head>
<body>
  <div class="topbar">Logged in as <b>${escapeHtml(username)}</b> | <a href="/upload" style="color:#2dd4bf;">Re-upload design</a></div>
  <div class="tabs">${tabsHtml}</div>
  ${screensHtml}
  <div class="status" id="status">Connecting...</div>
  <div class="toast" id="toast"></div>
<script>
function gotoScreen(id){
  document.querySelectorAll('.screen').forEach(function(s){s.style.display='none';});
  document.querySelectorAll('.stab').forEach(function(t){t.classList.remove('active');});
  var t=document.getElementById('screen'+id); if(t)t.style.display='block';
  var tb=document.getElementById('tabbtn'+id); if(tb)tb.classList.add('active');
}
function showToast(msg){
  var t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(function(){t.classList.remove('show');},2000);
}
async function sendCmd(tagId, action){
  try{
    const res = await fetch('/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tagId:tagId,action:action})});
    const json = await res.json();
    showToast(json.ok ? 'Command sent - PLC updates on next ESP32 poll' : 'Failed: '+json.error);
  }catch(e){ showToast('Network error sending command'); }
}
async function sendSet(tagId){
  const el = document.getElementById('in'+tagId);
  if(!el || el.value==='') { showToast('Enter a value first'); return; }
  try{
    const res = await fetch('/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tagId:tagId,action:'set',value:el.value})});
    const json = await res.json();
    showToast(json.ok ? 'Setpoint sent' : 'Failed: '+json.error);
  }catch(e){ showToast('Network error sending command'); }
}
function tickClocks(){
  var t = new Date().toLocaleTimeString();
  document.querySelectorAll('.clock-live').forEach(function(el){ el.textContent = t; });
}
setInterval(tickClocks, 1000); tickClocks();

async function refresh(){
  try{
    const res = await fetch('/data');
    const json = await res.json();
    const d = json.data || {};
    document.querySelectorAll('[data-tag]').forEach(function(el){
      const k = el.getAttribute('data-tag');
      const mode = el.getAttribute('data-mode');
      const v = d[k];
      if(v === undefined) return;
      if(mode==='onoff'){ el.textContent = (v==1?'ON':'OFF'); }
      else if(mode==='lamp'){ el.style.background = (v==1?'#0f6e56':'#555'); }
      else if(mode==='bulb'){ el.classList.toggle('on', v==1); }
      else if(mode==='alarmtext'){
        el.textContent = (v==1?'ALARM':'Normal');
        const card = document.getElementById('card'+k);
        if(card){ card.style.background = v==1 ? '#4a1b0c' : ''; card.style.borderColor = v==1 ? '#e24b4a' : ''; }
      }
      else if(mode==='alarmcode'){
        let codes = [];
        try{ codes = JSON.parse(el.getAttribute('data-codes')||'[]'); }catch(e){}
        const match = codes.find(function(c){ return String(c.val)===String(v); });
        el.textContent = match ? match.text : 'Normal';
        const card = document.getElementById('card'+k);
        if(card){ card.style.background = (v!=0) ? '#4a1b0c' : ''; card.style.borderColor = (v!=0) ? '#e24b4a' : ''; }
      }
      else { el.textContent = v; }
    });
    const status = document.getElementById('status');
    if(json.lastUpdate){
      const secsAgo = Math.round((Date.now()-json.lastUpdate)/1000);
      status.textContent = 'Last update: '+secsAgo+'s ago';
      status.className = secsAgo>30 ? 'status stale' : 'status';
    } else {
      status.textContent = 'No data received yet';
    }
  }catch(e){
    document.getElementById('status').textContent = 'Connection error';
  }
}
setInterval(refresh, 2000);
refresh();
</script>
</body></html>`;
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('Receiver server v4 (multi-user) running on port ' + PORT);
});
