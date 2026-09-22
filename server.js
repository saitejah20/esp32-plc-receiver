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
  channels[id] = { owner: req.session.username, name, apiKey: genApiKey(), fieldNames, history: [] };
  saveChannels(channels);
  res.redirect('/channels/' + id);
});

// ---------------- ThingSpeak-compatible update endpoint (NO login needed - uses API key) ----------------
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

  const cardsHtml = ch.fieldNames.map((fname, i) =>
    `<div class="card"><div class="lbl">${escapeHtml(fname)}</div><div class="val" id="v${i + 1}">--</div><canvas id="c${i + 1}" width="400" height="120"></canvas></div>`
  ).join('');

  res.send(`<!DOCTYPE html>
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
</style></head>
<body>
  <a href="/">&larr; All my channels</a>
  <h1>${escapeHtml(ch.name)}</h1>
  <div class="writekey">POST to this URL from your ESP32: <br><code>https://YOUR-SERVER/update?api_key=${ch.apiKey}&field1=VALUE&field2=VALUE</code></div>
  <div class="grid">${cardsHtml}</div>
  <div class="status" id="status">Loading...</div>
<script>
async function refresh(){
  try{
    const res = await fetch('/channels/${req.params.id}/data');
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
</body></html>`);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('Mini ThingSpeak v2 running on port ' + PORT);
});
