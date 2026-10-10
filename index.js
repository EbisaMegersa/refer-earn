// ============================================================
//  TELEGRAM "REFER & EARN" MINI APP — Cloudflare Worker + D1
// ============================================================

// ------------------- CONFIG — EDIT THIS ---------------------
const BOT_USERNAME   = "tanvexoappbot"; // your bot's @username, no @ (Step 1)
const APP_NAME       = "earn";         // mini-app SHORT NAME you'll give BotFather (Step 7), lowercase
const ADMIN_ID       = 2022805638;     // your Telegram ID (Step 9). 0 = admin off for now
const REF_BONUS      = 100;            // points per invited friend
const JOIN_BONUS     = 50;             // points a new user starts with
const MIN_WITHDRAW   = 1000;           // minimum points to withdraw
const VERIFY_FILE    = "";             // ONLY if BotFather asks to verify your domain (Step 7)
const VERIFY_CONTENT = "tanvexoappbot"; // FIX: Added quotes around string
const WEBHOOK_SECRET = "";             // optional Step 11: any random text
// -------------------------------------------------------------

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;
    try {
      if (VERIFY_FILE && p === "/" + VERIFY_FILE)
        return new Response(VERIFY_CONTENT, { headers: { "content-type": "text/plain" } });
      if (p === "/api/login")       return handleLogin(request, env);
      if (p === "/api/leaderboard") return handleLeaderboard(request, env);
      if (p === "/api/withdraw")    return handleWithdraw(request, env);
      if (p === "/api/admin/wd")    return handleAdmin(request, env);
      if (p === "/webhook")         return handleWebhook(request, env);
      if (p === "/")
        return new Response(HTML, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },
};

// ------------------------- helpers --------------------------
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json" } });
}
function genCode() {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT DEFAULT '', first_name TEXT DEFAULT '', points INTEGER DEFAULT 0, ref_code TEXT UNIQUE, referred_by INTEGER, created_at INTEGER)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, points INTEGER, method TEXT DEFAULT '', details TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at INTEGER)").run();
  schemaReady = true;
}
async function tgApi(env, method, body) {
  try {
    const r = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { ok: false }; }
}

// Validate Telegram initData (HMAC-SHA256 with bot token)
async function auth(request, env) {
  const raw = request.headers.get("Authorization") || "";
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date") || 0);
  if (!hash || !authDate || Date.now() / 1000 - authDate > 604800) return null;
  const pairs = [];
  for (const [k, v] of params.entries()) if (k !== "hash" && k !== "signature") pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const dcs = pairs.map((x) => x[0] + "=" + x[1]).join("\n");
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey("raw", enc.encode(env.BOT_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, enc.encode("WebAppData"));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k2, enc.encode(dcs));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex === hash ? params : null;
}

// Create-or-update user; credit referral on FIRST login only
async function upsertUser(env, from, startParam) {
  const db = env.DB;
  let row = await db.prepare("SELECT * FROM users WHERE id=?").bind(from.id).first();
  if (row) {
    await db.prepare("UPDATE users SET first_name=?, username=? WHERE id=?")
      .bind(from.first_name || "Friend", from.username || "", from.id).run();
    return row;
  }
  let refBy = null;
  if (startParam && startParam.indexOf("ref") === 0 && startParam.length > 3) {
    const r = await db.prepare("SELECT id FROM users WHERE ref_code=?").bind(startParam.slice(3)).first();
    if (r && r.id !== from.id) refBy = r.id;
  }
  let code = genCode();
  for (let i = 0; i < 6; i++) {
    const taken = await db.prepare("SELECT 1 FROM users WHERE ref_code=?").bind(code).first();
    if (!taken) break;
    code = genCode();
  }
  await db.prepare("INSERT INTO users (id, username, first_name, points, ref_code, referred_by, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(from.id, from.username || "", from.first_name || "Friend", JOIN_BONUS, code, refBy, Date.now()).run();
  if (refBy) await db.prepare("UPDATE users SET points = points + ? WHERE id=?").bind(REF_BONUS, refBy).run();
  return await db.prepare("SELECT * FROM users WHERE id=?").bind(from.id).first();
}

// ------------------------- API ------------------------------
async function handleLogin(request, env) {
  const params = await auth(request, env);
  if (!params) return json({ ok: false, error: "login failed — check BOT_TOKEN secret" }, 401);
  const u = JSON.parse(params.get("user"));
  await ensureSchema(env.DB);
  const row = await upsertUser(env, u, params.get("start_param") || "");
  const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE referred_by=?").bind(u.id).first();
  return json({ ok: true, user: {
    id: row.id, name: row.first_name || row.username || "Friend",
    points: row.points, referrals: c ? c.c : 0,
    link: "https://t.me/" + BOT_USERNAME + "/" + APP_NAME + "?startapp=ref" + row.ref_code,
    isAdmin: ADMIN_ID !== 0 && row.id === ADMIN_ID,
    refBonus: REF_BONUS, joinBonus: JOIN_BONUS, minWithdraw: MIN_WITHDRAW,
  }});
}

async function handleLeaderboard(request, env) {
  const params = await auth(request, env);
  if (!params) return json({ ok: false }, 401);
  const u = JSON.parse(params.get("user"));
  const rows = await env.DB.prepare("SELECT id, first_name, username, points FROM users ORDER BY points DESC LIMIT 50").all();
  const list = (rows.results || []).map((r, i) => ({
    rank: i + 1, name: r.first_name || r.username || "Friend", points: r.points, me: r.id === u.id,
  }));
  return json({ ok: true, list });
}

async function handleWithdraw(request, env) {
  const params = await auth(request, env);
  if (!params) return json({ ok: false }, 401);
  const u = JSON.parse(params.get("user"));
  const db = env.DB;
  if (request.method === "GET") {
    const rows = await db.prepare("SELECT id, points, method, details, status, created_at FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 20").bind(u.id).all();
    return json({ ok: true, list: rows.results || [] });
  }
  const body = await request.json().catch(() => ({}));
  const amount = Math.floor(Number(body.amount));
  const method = String(body.method || "USDT").slice(0, 40);
  const details = String(body.details || "").trim().slice(0, 120);
  if (!details) return json({ ok: false, error: "Enter your payout details" });
  if (!amount || amount < MIN_WITHDRAW) return json({ ok: false, error: "Minimum " + MIN_WITHDRAW + " points" });
  const upd = await db.prepare("UPDATE users SET points = points - ? WHERE id=? AND points >= ?").bind(amount, u.id, amount).run();
  if (!upd.success || !upd.meta.changes) return json({ ok: false, error: "Not enough points" });
  await db.prepare("INSERT INTO withdrawals (user_id, points, method, details, created_at) VALUES (?,?,?,?,?)")
    .bind(u.id, amount, method, details, Date.now()).run();
  return json({ ok: true });
}

async function handleAdmin(request, env) {
  const params = await auth(request, env);
  if (!params) return json({ ok: false, error: "not authorized" }, 401);
  const u = JSON.parse(params.get("user"));
  if (!ADMIN_ID || u.id !== ADMIN_ID) return json({ ok: false, error: "admins only" }, 403);
  const db = env.DB;
  if (request.method === "GET") {
    const rows = await db.prepare("SELECT w.id, w.points, w.method, w.details, w.status, w.created_at, COALESCE(NULLIF(us.first_name,''), us.username, 'user') AS name FROM withdrawals w LEFT JOIN users us ON us.id = w.user_id ORDER BY w.id DESC LIMIT 50").all();
    return json({ ok: true, list: rows.results || [] });
  }
  const body = await request.json().catch(() => ({}));
  const w = await db.prepare("SELECT * FROM withdrawals WHERE id=?").bind(Number(body.id)).first();
  if (!w || w.status !== "pending") return json({ ok: false, error: "not found or already processed" });
  if (body.action === "approve") {
    await db.prepare("UPDATE withdrawals SET status='paid' WHERE id=?").bind(w.id).run();
  } else if (body.action === "reject") {
    await db.batch([
      db.prepare("UPDATE withdrawals SET status='rejected' WHERE id=?").bind(w.id),
      db.prepare("UPDATE users SET points = points + ? WHERE id=?").bind(w.points, w.user_id),
    ]);
  } else return json({ ok: false, error: "bad action" });
  return json({ ok: true });
}

// Optional: welcome message when someone presses START
async function handleWebhook(request, env) {
  if (request.method !== "POST") return json({ ok: true });
  if (!WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) return json({ ok: false }, 401);
  const upd = await request.json().catch(() => null);
  const msg = upd && upd.message;
  if (!msg || !msg.text || msg.text.indexOf("/start") !== 0) return json({ ok: true });
  await ensureSchema(env.DB);
  await upsertUser(env, msg.from, (msg.text.split(" ")[1] || "").trim());
  const origin = new URL(request.url).origin;
  const text = "👋 Welcome " + (msg.from.first_name || "") + "!\n\nInvite friends and earn " + REF_BONUS + " points for each one. Open the app to see your balance, invite link and withdrawals.";
  const kb = { inline_keyboard: [[{ text: "🚀 Open App", web_app: { url: origin } }]] };
  const r = await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: text, reply_markup: kb });
  if (!r || !r.ok) await tgApi(env, "sendMessage", { chat_id: msg.chat.id, text: text });
  return json({ ok: true });
}

// ---------------------- FRONTEND ----------------------------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Refer & Earn</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:#0e1424;--card:#182136;--card2:#22304f;--acc:#3ea6ff;--gold:#ffc83d;--txt:#eef3fb;--mut:#93a1bb}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{font-family:system-ui,-apple-system,Roboto,sans-serif;background:var(--bg);color:var(--txt);min-height:100vh;padding-bottom:80px}
.wrap{max-width:500px;margin:0 auto;padding:14px}
.hero{background:linear-gradient(135deg,#26406e,#101a30);border-radius:18px;padding:24px 16px;text-align:center;margin-bottom:14px}
.hero small{color:var(--mut);letter-spacing:2px;font-size:11px}
.hero .pts{font-size:42px;font-weight:800;color:var(--gold)}
.card{background:var(--card);border-radius:16px;padding:16px;margin-bottom:14px}
.row{display:flex;justify-content:space-between;align-items:center}
.mut{color:var(--mut);font-size:13px}
.btn{display:block;width:100%;border:0;border-radius:12px;padding:14px;font-size:15px;font-weight:700;background:var(--acc);color:#fff;margin-top:10px;cursor:pointer}
.btn2{background:var(--card2)}
.link{background:var(--card2);border-radius:10px;padding:12px;font-size:12px;word-break:break-all;margin-top:10px;color:#bcd7ff}
nav{position:fixed;left:0;right:0;bottom:0;background:#0f1a2f;border-top:1px solid #22304f;display:flex;justify-content:space-around;padding:8px 4px calc(8px + env(safe-area-inset-bottom))}
nav button{background:0;border:0;color:var(--mut);font-size:11px;font-weight:700;padding:6px 12px;border-radius:12px;display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer}
nav button.on{color:var(--acc);background:#16233c}
nav button b{font-size:19px;font-weight:400}
ol{padding-left:20px;line-height:1.8;font-size:14px}
.item{display:flex;justify-content:space-between;gap:8px;padding:12px 2px;border-bottom:1px solid #22304f;font-size:14px}
.item:last-child{border-bottom:0}
.me{color:var(--acc)}
input,select{width:100%;background:var(--card2);border:1px solid #2a3a5f;border-radius:10px;color:var(--txt);padding:12px;font-size:15px;margin-top:8px}
.pending{color:var(--gold)}.paid{color:#2ecc71}.rejected{color:#ff6b6b}
.mini{border:0;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:700;margin:3px 3px 0 0;cursor:pointer}
.ok{background:#1d7a4c;color:#fff}.bad{background:#8a2b2b;color:#fff}
#toast{position:fixed;left:50%;transform:translateX(-50%);bottom:92px;background:#2b3a5c;padding:10px 18px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none;max-width:90%;white-space:nowrap}
#toast.show{opacity:1}
</style>
</head>
<body>
<div class="wrap" id="msg" style="display:none"></div>
<div class="wrap" id="app" style="display:none">

<section id="home">
  <div class="hero">
    <small>YOUR BALANCE</small>
    <div class="pts" id="pts">0</div>
    <small>points</small>
  </div>
  <div class="card">
    <div class="row"><b>Invite friends 🎁</b><span class="mut" id="refc">0 joined</span></div>
    <div class="mut" style="margin-top:8px">You earn <b id="rb">100</b> pts per friend — they instantly get <b id="jb">50</b> pts too.</div>
    <div class="link" id="lnk">loading…</div>
    <button class="btn" onclick="copyLink()">📋 Copy invite link</button>
    <button class="btn btn2" onclick="shareLink()">📤 Share with friends</button>
  </div>
  <div class="card"><b>How it works</b>
    <ol>
      <li>Copy or share your invite link.</li>
      <li>Your friend opens it and launches the app.</li>
      <li>You both get points instantly.</li>
      <li>Request a withdrawal from the 💸 tab.</li>
    </ol>
  </div>
  <div class="mut" style="text-align:center;padding:6px 0 20px">Your ID: <span id="myid">…</span></div>
</section>

<section id="top" style="display:none">
  <div class="card"><b>🏆 Top earners</b><div id="board"><div class="mut">Loading…</div></div></div>
</section>

<section id="wd" style="display:none">
  <div class="card">
    <b>💸 Withdraw</b>
    <div class="mut" style="margin-top:4px">Minimum <b id="minw">1000</b> points.</div>
    <select id="wmethod"><option>USDT (TRC20)</option><option>UPI / PhonePe</option><option>PayPal</option></select>
    <input id="wdet" placeholder="Your address / number / email">
    <input id="wamt" type="number" inputmode="numeric" placeholder="Points to withdraw">
    <button class="btn" onclick="withdraw()">Request withdrawal</button>
  </div>
  <div class="card"><b>Your requests</b><div id="wlist" class="mut">None yet.</div></div>
</section>

<section id="admin" style="display:none">
  <div class="card"><b>🛡️ Admin — withdrawal requests</b><div id="alist" class="mut">Loading…</div></div>
</section>

</div>
<nav id="nav" style="display:none">
  <button id="t-home" class="on" onclick="tab('home')"><b>🏠</b>Home</button>
  <button id="t-top" onclick="tab('top')"><b>🏆</b>Top</button>
  <button id="t-wd" onclick="tab('wd')"><b>💸</b>Withdraw</button>
  <button id="t-admin" onclick="tab('admin')" style="display:none"><b>🛡️</b>Admin</button>
</nav>
<div id="toast"></div>
<script>
var tg=window.Telegram.WebApp;tg.ready();tg.expand();
if(tg.setBackgroundColor)tg.setBackgroundColor('#0e1424');
var me=null;
function $(id){return document.getElementById(id)}
function toast(t){var e=$('toast');e.textContent=t;e.className='show';setTimeout(function(){e.className=''},2200)}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
async function api(path,body){
  try{
    var o={method:body?'POST':'GET',headers:{'Authorization':tg.initData}};
    if(body){o.headers['Content-Type']='application/json';o.body=JSON.stringify(body)}
    var r=await fetch(path,o);
    return await r.json();
  }catch(e){return{ok:false,error:'network error'}}
}
async function boot(){
  if(!tg.initData||!tg.initDataUnsafe||!tg.initDataUnsafe.user){
    $('msg').style.display='block';
    $('msg').innerHTML='<div class="card">⚠️ Please open this app from inside Telegram.</div>';
    return;
  }
  var r=await api('/api/login');
  if(!r.ok){
    $('msg').style.display='block';
    $('msg').innerHTML='<div class="card">Login failed: '+esc(r.error||'unknown')+'</div>';
    return;
  }
  me=r.user;
  $('pts').textContent=me.points;
  $('refc').textContent=me.referrals+' joined';
  $('lnk').textContent=me.link;
  $('rb').textContent=me.refBonus;
  $('jb').textContent=me.joinBonus;
  $('minw').textContent=me.minWithdraw;
  $('myid').textContent=me.id;
  if(me.isAdmin)$('t-admin').style.display='flex';
  $('app').style.display='block';
  $('nav').style.display='flex';
  loadBoard();loadW();if(me.isAdmin)loadA();
}
function tab(t){
  var s=['home','top','wd','admin'];
  for(var i=0;i<s.length;i++){
    $(s[i]).style.display=s[i]===t?'block':'none';
    $('t-'+s[i]).className=s[i]===t?'on':'';
  }
}
async function copyLink(){
  try{await navigator.clipboard.writeText(me.link);toast('Invite link copied ✔')}
  catch(e){
    var a=document.createElement('textarea');a.value=me.link;document.body.appendChild(a);a.select();
    try{document.execCommand('copy');toast('Invite link copied ✔')}catch(e2){toast('Long-press the link to copy')}
    document.body.removeChild(a);
  }
}
function shareLink(){
  var t='Join me and start earning rewards 🎁';
  tg.openTelegramLink('https://t.me/share/url?url='+encodeURIComponent(me.link)+'&text='+encodeURIComponent(t));
}
async function loadBoard(){
  var r=await api('/api/leaderboard');if(!r.ok)return;
  var h='';var med=['🥇','🥈','🥉'];
  (r.list||[]).forEach(function(x){
    h+='<div class="item'+(x.me?' me':'')+'"><span>'+(x.rank<=3?med[x.rank-1]:'#'+x.rank)+' '+esc(x.name)+'</span><b>'+x.points+' pts</b></div>';
  });
  $('board').innerHTML=h||'<div class="mut">Nobody yet — invite friends!</div>';
}
async function loadW(){
  var r=await api('/api/withdraw');if(!r.ok)return;
  var h='';
  (r.list||[]).forEach(function(w){
    h+='<div class="item"><span>'+esc(w.method)+'<div class="mut">'+new Date(w.created_at).toLocaleDateString()+'</div></span><span style="text-align:right"><b>'+w.points+' pts</b><div class="mut '+w.status+'">'+w.status+'</div></span></div>';
  });
  $('wlist').innerHTML=h||'<div class="mut">None yet.</div>';
}
async function withdraw(){
  var amt=Math.floor(Number($('wamt').value));
  var det=$('wdet').value.trim();
  if(!det){toast('Enter your payout details');return}
  var r=await api('/api/withdraw',{amount:amt,details:det,method:$('wmethod').value});
  toast(r.ok?'Request sent ✔':(r.error||'Failed'));
  if(r.ok){
    $('wdet').value='';$('wamt').value='';
    var m=await api('/api/login');
    if(m.ok){me=m.user;$('pts').textContent=me.points}
    loadW();
  }
}
async function loadA(){
  var r=await api('/api/admin/wd');if(!r.ok)return;
  var h='';
  (r.list||[]).forEach(function(w){
    var b='';
    if(w.status==='pending')b='<br><button class="mini ok" onclick="wdAction('+w.id+',\'approve\')">Mark paid</button><button class="mini bad" onclick="wdAction('+w.id+',\'reject\')">Reject & refund</button>';
    h+='<div class="item"><span>'+esc(w.name)+'<div class="mut">'+esc(w.method)+' · '+esc(w.details)+'</div></span><span style="text-align:right"><b>'+w.points+' pts</b><div class="mut '+w.status+'">'+w.status+'</div>'+b+'</span></div>';
  });
  $('alist').innerHTML=h||'<div class="mut">No requests yet.</div>';
}
async function wdAction(id,action){
  var r=await api('/api/admin/wd',{id:id,action:action});
  toast(r.ok?'Done ✔':(r.error||'Failed'));loadA();
}
boot();
</script>
</body>
</html>`;
