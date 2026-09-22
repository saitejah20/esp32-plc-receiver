/*
   ESP32 PLC Panel - Remote Receiver Server (v3)
   - Live data from ESP32 (/data POST)
   - Panel design upload for full styled dashboard (/upload, /design)
   - Username/password protection (Basic Auth) on everything
   - REMOTE CONTROL: since the ESP32 sits behind your router (no public
     address), the browser can't talk to it directly. Instead:
       1. Browser clicks a switch -> POST /command (queued here)
       2. ESP32 polls GET /commands every couple seconds
       3. ESP32 executes the command via Modbus, server clears the queue
     This is why control has a small delay (up to your ESP32's poll
     interval) compared to switches on the ESP32's own local page.

   ---------------- SET YOUR LOGIN CREDENTIALS ----------------
   On Render: go to your service -> Environment -> add:
     ADMIN_USER = your chosen username
     ADMIN_PASS = your chosen password
   (Don't hardcode real credentials directly in this file if the repo
   is public - use environment variables instead, as done below.)
*/

const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123';

// ---------------- Basic Auth (protects every route, including ESP32 calls) ----------------
app.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="PLC Panel"');
  res.status(401).send('Authentication required');
});

let latestData = {};
let lastUpdateTime = null;
let panelDesign = null;
let pendingCommands = [];

const HISTORY_LIMIT = 200;
let history = [];

// ---------------- ESP32 <-> server data sync ----------------
app.post('/data', (req, res) => {
  latestData = req.body || {};
  lastUpdateTime = Date.now();
  history.push({ t: lastUpdateTime, ...latestData });
  if (history.length > HISTORY_LIMIT) history.shift();
  res.json({ ok: true });
});

app.get('/data', (req, res) => {
  res.json({ data: latestData, lastUpdate: lastUpdateTime });
});

app.get('/history', (req, res) => {
  res.json(history);
});

// ESP32 polls this for pending control actions, then we clear the queue
app.get('/commands', (req, res) => {
  const cmds = pendingCommands;
  pendingCommands = [];
  res.json(cmds);
});

// ---------------- Panel design ----------------
app.post('/design', (req, res) => {
  panelDesign = req.body;
  res.json({ ok: true, screens: (panelDesign.screens || []).length });
});
app.get('/design', (req, res) => {
  res.json(panelDesign || {});
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
  <p>Export this from the Panel Builder tool, then upload it here once.</p>
  <input type="file" id="file" accept=".json"><br>
  <button onclick="upload()">Upload</button>
  <div id="msg"></div>
  <p><a href="/">&larr; Back to dashboard</a></p>
<script>
async function upload(){
  const f = document.getElementById('file').files[0];
  if(!f){ document.getElementById('msg').textContent = 'Choose a file first'; return; }
  const text = await f.text();
  const res = await fetch('/design', { method:'POST', headers:{'Content-Type':'application/json'}, body:text });
  const json = await res.json();
  document.getElementById('msg').innerHTML = 'Uploaded! ' + json.screens + ' screen(s) loaded. <a href="/">Go to the dashboard</a>.';
}
</script>
</body></html>`);
});

// ---------------- Helpers ----------------
const DESIGN_W_DEFAULT = 1200, DESIGN_H_DEFAULT = 750;
function pct(v, total) { return (v / total * 100).toFixed(2); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
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
function findWidget(tagId) {
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

// ---------------- Queue a control command from the browser ----------------
// body: { tagId, action: 'on'|'off'|'toggle'|'set', value (for 'set') }
app.post('/command', (req, res) => {
  const { tagId, action, value } = req.body || {};
  const w = findWidget(tagId);
  if (!w) return res.status(404).json({ ok: false, error: 'Unknown tag' });

  if (action === 'on' || action === 'off') {
    if (!isCoilType(w.type)) return res.status(400).json({ ok: false, error: 'Not a coil-type widget' });
    pendingCommands.push({ type: 'coil', address: w.address, value: action === 'on' ? 1 : 0 });
  } else if (action === 'toggle') {
    if (!isCoilType(w.type)) return res.status(400).json({ ok: false, error: 'Not a coil-type widget' });
    const current = latestData[tagId] == 1 ? 1 : 0;
    pendingCommands.push({ type: 'coil', address: w.address, value: current ? 0 : 1 });
  } else if (action === 'set') {
    const v = parseInt(value);
    if (isNaN(v)) return res.status(400).json({ ok: false, error: 'Invalid value' });
    pendingCommands.push({ type: 'register', address: w.address, value: v });
  } else {
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }
  res.json({ ok: true, queued: pendingCommands.length });
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
      return `<div class="w" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="plain" style="${valStyle}">${'--'}</div>${comment}</div>`;
  }
}

// ---------------- Dashboards ----------------
app.get('/', (req, res) => {
  if (!panelDesign || !panelDesign.screens || !panelDesign.screens.length) {
    return res.send(genericDashboard());
  }
  res.send(styledDashboard(panelDesign));
});

function genericDashboard() {
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
  <p>No panel design uploaded yet - showing raw tag values. <a href="/upload">Upload your panel_design.json</a> to see your real styled panel with controls.</p>
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

function styledDashboard(design) {
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
  console.log('Receiver server v3 running on port ' + PORT);
  console.log('Login user: ' + ADMIN_USER + ' (set ADMIN_USER/ADMIN_PASS env vars to change)');
});
