/*
   ESP32 PLC Panel - Remote Receiver Server (v2)
   - Accepts JSON POST from your ESP32 (/data) - the live tag values
   - Accepts your exported panel design (/design) - upload panel_design.json
     once (via /upload), and this server renders your ACTUAL styled panel
     (positions, colors, widget types, multi-screen) instead of a generic table.
   - Falls back to a plain generic table if no design has been uploaded yet.
   - Updates values in place via fetch polling - no page reloads.
*/

const express = require('express');
const app = express();
app.use(express.json({ limit: '2mb' }));

let latestData = {};
let lastUpdateTime = null;
let panelDesign = null; // set via POST /design or the /upload page

const HISTORY_LIMIT = 200;
let history = [];

// ---------------- Receive live data from ESP32 ----------------
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

// ---------------- Receive the panel design (from the builder's Export button) ----------------
app.post('/design', (req, res) => {
  panelDesign = req.body;
  res.json({ ok: true, screens: (panelDesign.screens || []).length });
});

app.get('/design', (req, res) => {
  res.json(panelDesign || {});
});

// ---------------- Simple upload page for the design JSON file ----------------
app.get('/upload', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Upload Panel Design</title>
<style>body{font-family:system-ui,sans-serif;background:#14181d;color:#e7ebef;padding:40px;text-align:center;}
input,button{padding:10px;margin-top:16px;border-radius:6px;border:1px solid #2f3944;background:#232a32;color:#e7ebef;}
button{background:#f0a020;color:#1a1200;font-weight:600;cursor:pointer;border:none;}
#msg{margin-top:16px;color:#2dd4bf;} a{color:#2dd4bf;}</style></head>
<body>
  <h2>Upload panel_design.json</h2>
  <p>Export this from the Panel Builder tool ("Export Design (JSON)" button), then upload it here once.</p>
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

// ---------------- Widget rendering helpers (mirrors the ESP32 builder's style) ----------------
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

// Renders a widget's static frame (position/label/box). The VALUE itself gets
// a data-tag attribute so client JS can update it in place without reloading.
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
      return `<div class="w" id="card${w.id}" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="onoff" style="${valStyle}">--</div>${comment}</div>`;

    case 'lamp':
      return `<div class="w" style="${boxStyle}flex-direction:row;gap:8px;"><span class="lamp" data-tag="${w.id}" data-mode="lamp"></span><span class="lbl">${label}</span>${comment}</div>`;

    case 'bulb':
      return `<div class="w" style="${boxStyle}color:${color};"><div class="bulb" data-tag="${w.id}" data-mode="bulb"></div><div class="lbl">${label}</div>${comment}</div>`;

    case 'alarm': case 'alarmbanner':
      return `<div class="w" id="card${w.id}" data-tag="${w.id}" data-mode="alarmcard" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="alarmtext" style="${valStyle}">--</div>${comment}</div>`;

    case 'alarmcode':
      return `<div class="w" id="card${w.id}" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="alarmcode" data-codes='${JSON.stringify(parseCodes(w.codesText)).replace(/'/g,"&#39;")}' style="${valStyle}">--</div>${comment}</div>`;

    case 'clock':
      return `<div class="w" style="${boxStyle}"><div class="lbl">${label}</div><div class="val clock-live" style="${valStyle}">--:--:--</div>${comment}</div>`;

    case 'commstatus':
      return `<div class="w" style="${boxStyle}flex-direction:row;gap:8px;"><span class="lamp" data-tag="commOK" data-mode="lamp"></span><span class="lbl">${label}</span>${comment}</div>`;

    case 'gotoscreen':
      return `<div class="w" style="${boxStyle}"><div class="lbl">${label}</div><button onclick="gotoScreen(${w.targetScreenId})">Go</button>${comment}</div>`;

    default: // value16, value32, gauge, tank, silo, piechart, radialgauge, setpoint, slider, knob, motor, valve, pipe, heater, fan
      return `<div class="w" style="${boxStyle}"><div class="lbl">${label}</div><div class="val" data-tag="${w.id}" data-mode="plain" style="${valStyle}">--</div>${comment}</div>`;
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
  <p>No panel design uploaded yet - showing raw tag values. <a href="/upload">Upload your panel_design.json</a> to see your real styled panel.</p>
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
  button{margin-top:6%;padding:5px 12px;border-radius:4px;border:1px solid #2f3944;background:#1c2229;color:#e7ebef;cursor:pointer;}
  .lamp{width:14px;height:14px;border-radius:50%;flex-shrink:0;background:#555;}
  .bulb{width:50%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle,#555,#333);margin:4% auto;}
  .bulb.on{box-shadow:0 0 20px 6px currentColor;}
  .status{font-size:11px;color:#8a97a3;text-align:center;margin-top:14px;}
  .status.stale{color:#e24b4a;}
</style></head>
<body>
  <div class="tabs">${tabsHtml}</div>
  ${screensHtml}
  <div class="status" id="status">Connecting...</div>
<script>
function gotoScreen(id){
  document.querySelectorAll('.screen').forEach(function(s){s.style.display='none';});
  document.querySelectorAll('.stab').forEach(function(t){t.classList.remove('active');});
  var t=document.getElementById('screen'+id); if(t)t.style.display='block';
  var tb=document.getElementById('tabbtn'+id); if(tb)tb.classList.add('active');
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
        const card = document.getElementById(el.closest('.w').id);
        if(card){ card.style.background = v==1 ? '#4a1b0c' : ''; card.style.borderColor = v==1 ? '#e24b4a' : ''; }
      }
      else if(mode==='alarmcard'){ /* handled alongside alarmtext */ }
      else if(mode==='alarmcode'){
        let codes = [];
        try{ codes = JSON.parse(el.getAttribute('data-codes')||'[]'); }catch(e){}
        const match = codes.find(function(c){ return String(c.val)===String(v); });
        el.textContent = match ? match.text : 'Normal';
        const card = el.closest('.w');
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
  console.log('Receiver server v2 running on port ' + PORT);
});
