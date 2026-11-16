/* HOME as a standalone app: Google sign-in + Firestore.
   index.html calls window.claude.use("db") just like inside claude.ai; this file supplies
   that object, backed by Firestore under users/<uid>/..., once Adam has signed in. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, reauthenticateWithPopup, reauthenticateWithRedirect } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, onSnapshot, setDoc, deleteDoc, getDoc, writeBatch } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCXDKyIVgIHCKCcdGbLQQvcvtdFBQcaKVE",
  authDomain: "home-board-bd604.firebaseapp.com",
  projectId: "home-board-bd604",
  storageBucket: "home-board-bd604.firebasestorage.app",
  messagingSenderId: "841192426427",
  appId: "1:841192426427:web:b3ca0f1310e4805896d29e",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let fs;
try { fs = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { fs = initializeFirestore(app, { ignoreUndefinedProperties: true }); }

const TX = {
  title: "HOME", sub: "用你的 Google 帳號登入，資料會在所有裝置同步。",
  signin: "用 Google 登入", signing: "登入中…", fail: "登入失敗：",
  firstTitle: "第一次使用", firstSub: "要把舊版網頁的資料搬過來嗎？選擇 Claude 給你的 home-data.json。",
  pick: "選擇 home-data.json", skip: "略過，從空白開始", importing: "匯入中…", imported: n => `已匯入 ${n} 筆資料`, badFile: "這不是 HOME 的資料檔",
  denied: "資料庫拒絕存取：請確認 Firestore 規則已經貼上（見說明）。",
};

/* ---------- small overlay UI ---------- */
const css = document.createElement("style");
css.textContent = `#fbGate{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:var(--bg,#f7f7f5);padding:16px}
#fbGate .box{width:min(380px,100%);background:var(--surface,#fff);border:1px solid var(--line,#e3e4e1);border-radius:14px;padding:28px 24px;text-align:center;box-shadow:0 12px 36px rgba(0,0,0,.08)}
#fbGate .logo{width:52px;height:52px;border-radius:12px;background:#1d2124;color:#fff;display:grid;place-items:center;font:700 26px/1 system-ui;margin:0 auto 14px}
#fbGate h1{font-size:22px;margin:0 0 6px}#fbGate p{color:var(--muted,#6d747a);font-size:14px;margin:0 0 18px;line-height:1.6}
#fbGate button,#fbGate label.btn{display:block;width:100%;padding:11px 14px;border-radius:10px;border:1px solid var(--line,#e3e4e1);background:var(--surface,#fff);color:var(--fg,#1d2124);font:500 15px/1.2 inherit;cursor:pointer;margin-top:8px}
#fbGate .primary{background:var(--accent,#2f5d8a);border-color:var(--accent,#2f5d8a);color:#fff}
#fbGate .err{color:var(--hot,#c2412d);font-size:13px;margin-top:12px;min-height:1em}
#fbGate input[type=file]{display:none}`;
document.head.appendChild(css);
function gate(html) {
  let g = document.getElementById("fbGate");
  if (!html) { g && g.remove(); return null; }
  if (!g) { g = document.createElement("div"); g.id = "fbGate"; document.body.appendChild(g); }
  g.innerHTML = `<div class="box"><div class="logo">H</div>${html}</div>`;
  return g;
}

/* ---------- the db object index.html expects ---------- */
function dbFor(uid) {
  const ref = p => doc(fs, "users", uid, ...p.split("/"));
  return {
    collection: name => ({
      onSnapshot: (cb, err) => onSnapshot(collection(fs, "users", uid, name), { includeMetadataChanges: true },
        s => cb({ metadata: { fromCache: s.metadata.fromCache }, docs: s.docs.map(d => ({ id: d.id, data: () => d.data() })) }),
        e => err && err(e)),
    }),
    doc: p => ({
      // offline: the write lands in the local cache now and syncs later, so don't wait for the server
      set: b => { const w = setDoc(ref(p), b); return navigator.onLine ? w : (w.catch(() => {}), Promise.resolve()); },
      delete: () => { const w = deleteDoc(ref(p)); return navigator.onLine ? w : (w.catch(() => {}), Promise.resolve()); },
      onSnapshot: (cb, err) => onSnapshot(ref(p), { includeMetadataChanges: true },
        s => cb({ exists: s.exists(), data: () => s.data(), metadata: { fromCache: s.metadata.fromCache } }),
        e => err && err(e)),
    }),
  };
}

/* ---------- one-time import of the old claude.ai data ---------- */
function cleanSettings(s) {
  s = JSON.parse(JSON.stringify(s));
  const blob = v => typeof v === "string" && v.startsWith("/_blob/");
  if (s.customWps) { s.customWps = s.customWps.filter(w => !blob(w.url)); if (!s.customWps.length) delete s.customWps; }
  if (s.wp) for (const k in s.wp) if (blob(s.wp[k])) delete s.wp[k];
  if (s.wpPos) for (const k in s.wpPos) if (blob(k)) delete s.wpPos[k];
  return s;
}
async function importFile(uid, file) {
  const j = JSON.parse(await file.text());
  const data = j && j.app === "home-board" && j.data;
  if (!data) throw new Error(TX.badFile);
  let n = 0, batch = writeBatch(fs), inBatch = 0;
  for (const [col, docs] of Object.entries(data)) for (const [id, body] of Object.entries(docs)) {
    const b = col === "settings" && id === "main" ? cleanSettings(body) : body;
    batch.set(doc(fs, "users", uid, col, id), b); n++; inBatch++;
    if (inBatch >= 400) { await batch.commit(); batch = writeBatch(fs); inBatch = 0; }
  }
  if (inBatch) await batch.commit();
  return n;
}
function firstRun(uid) {
  return new Promise(resolve => {
    const g = gate(`<h1>${TX.firstTitle}</h1><p>${TX.firstSub}</p>
      <label class="btn primary">${TX.pick}<input type="file" accept=".json,application/json"></label>
      <button data-skip>${TX.skip}</button><div class="err"></div>`);
    g.querySelector("[data-skip]").onclick = () => resolve();
    g.querySelector("input").onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const er = g.querySelector(".err"); er.textContent = TX.importing;
      try { const n = await importFile(uid, f); er.textContent = TX.imported(n); setTimeout(resolve, 600); }
      catch (x) { er.textContent = (x && x.message) || String(x); }
    };
  });
}

/* ---------- sign-in flow ---------- */
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });
function showSignIn(msg = "") {
  const g = gate(`<h1>${TX.title}</h1><p>${TX.sub}</p><button class="primary" data-in>${TX.signin}</button><div class="err">${msg}</div>`);
  g.querySelector("[data-in]").onclick = async ev => {
    ev.target.textContent = TX.signing; ev.target.disabled = true;
    try { await signInWithPopup(auth, provider); }
    catch (e) {
      if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) { await signInWithRedirect(auth, provider); return; }
      if (e && e.code === "auth/popup-closed-by-user") { showSignIn(); return; }
      showSignIn(TX.fail + ((e && e.code) || e));
    }
  };
}
getRedirectResult(auth).then(r => { const c = r && GoogleAuthProvider.credentialFromResult(r); if (c && c.accessToken && sessionStorage.getItem("home.gcWant")) { sessionStorage.removeItem("home.gcWant"); gcSaveTok(c.accessToken); } })
  .catch(e => showSignIn(TX.fail + ((e && e.code) || e)));

/* ---------- Google Calendar ----------
   index.html talks to Google Calendar through window.claude.use("mcp") (callTool / watchTool / invalidate),
   the same shape it used inside claude.ai. Here that object calls the Calendar REST API with an OAuth token
   from Google sign-in (scope calendar.events). Google hands browser apps a token that lasts about an hour,
   so after it expires the page shows a "connect" button again; one tap renews it. */
const GC_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GC_API = "https://www.googleapis.com/calendar/v3";
function gcSaveTok(t) { try { localStorage.setItem("home.gcTok", JSON.stringify({ t, exp: Date.now() + 55 * 60e3 })); localStorage.setItem("home.gcEver", "1"); } catch (_) {} gcKick(); }
function gcTok() { try { const o = JSON.parse(localStorage.getItem("home.gcTok") || "null"); return o && o.exp > Date.now() ? o.t : null; } catch (_) { return null; } }
function gcDropTok() { try { localStorage.removeItem("home.gcTok"); } catch (_) {} }
const gcErr = code => Object.assign(new Error(code), { code });
async function gcConnect() {
  const u = auth.currentUser; if (!u) throw gcErr("needs_reauth");
  const p = new GoogleAuthProvider(); p.addScope(GC_SCOPE); p.setCustomParameters({ login_hint: u.email || "" });
  try { const r = await reauthenticateWithPopup(u, p); const c = GoogleAuthProvider.credentialFromResult(r); if (!c || !c.accessToken) throw gcErr("fail"); gcSaveTok(c.accessToken); }
  catch (e) {
    if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) { sessionStorage.setItem("home.gcWant", "1"); await reauthenticateWithRedirect(u, p); return; }
    throw e && e.code && e.code.startsWith("auth/popup-closed") ? gcErr("approval_required") : e;
  }
}
async function gcFetch(path, opt = {}) {
  const t = gcTok(); if (!t) throw gcErr("approval_required");
  const r = await fetch(GC_API + path, { ...opt, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", ...(opt.headers || {}) } });
  if (r.status === 401) { gcDropTok(); throw gcErr("approval_required"); }
  if (r.status === 204) return {};
  if (r.status === 404 || r.status === 410) throw gcErr("gone");
  if (r.status === 409) throw gcErr("exists");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.warn("[HOME] Google Calendar", r.status, j); const reason = j && j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
    throw gcErr(reason === "accessNotConfigured" ? "api_off" : r.status === 403 && reason === "insufficientPermissions" ? "approval_required" : "fail"); }
  return j;
}
const enc = encodeURIComponent, cal = id => "/calendars/" + enc(id || "primary");
function evBody(i) { return { ...(i.id ? { id: i.id } : {}), ...(i.status ? { status: i.status } : {}), ...(i.quiet ? { reminders: { useDefault: false, overrides: [] } } : {}), summary: i.summary, description: i.description || "HOME",
  start: i.allDay ? { date: i.startTime.slice(0, 10) } : { dateTime: i.startTime }, end: i.allDay ? { date: i.endTime.slice(0, 10) } : { dateTime: i.endTime } }; }
const tz = (() => { const o = -new Date().getTimezoneOffset(), a = Math.abs(o); return (o >= 0 ? "+" : "-") + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0"); })();
const TOOLS = {
  async list_events(i) {
    const q = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", maxResults: String(i.pageSize || 250) });
    if (i.startTime) q.set("timeMin", i.startTime + tz); if (i.endTime) q.set("timeMax", i.endTime + tz);
    const j = await gcFetch(cal(i.calendarId) + "/events?" + q); return { events: j.items || [] };
  },
  async create_event(i) { return await gcFetch(cal(i.calendarId) + "/events", { method: "POST", body: JSON.stringify(evBody(i)) }); },
  async update_event(i) { return await gcFetch(cal(i.calendarId) + "/events/" + enc(i.eventId), { method: "PATCH", body: JSON.stringify(evBody(i)) }); },
  async delete_event(i) { return await gcFetch(cal(i.calendarId) + "/events/" + enc(i.eventId), { method: "DELETE" }); },
};
const watchers = new Set();
function gcKick(tool) { watchers.forEach(w => (!tool || w.tool === tool) && w.run()); }
window.addEventListener("focus", () => gcTok() && gcKick());
const gcMcpObj = {
  connect: gcConnect,
  ready: () => !!gcTok(),
  everConnected: () => { try { return localStorage.getItem("home.gcEver") === "1"; } catch (_) { return false; } },
  async callTool(_server, name, input) { const f = TOOLS[name]; if (!f) throw gcErr("not_in_manifest"); return { payload: await f(input || {}) }; },
  watchTool(_server, name, input, cb, opt = {}) {
    const w = { tool: name, run: async () => { try { cb({ type: "data", result: { payload: await TOOLS[name](input || {}) } }); } catch (e) { cb({ type: "error", error: { code: e.code || "fail" } }); } } };
    watchers.add(w); w.run(); const iv = setInterval(w.run, opt.refetchInterval || 300000);
    return () => { clearInterval(iv); watchers.delete(w); };
  },
  async invalidate(_server, name) { gcKick(name); },
};

let started = false;
onAuthStateChanged(auth, async user => {
  if (!user) { if (started) location.reload(); else showSignIn(); return; }
  if (started) return;
  started = true;
  gate(`<p>${TX.signing}</p>`);
  try {
    const s = await getDoc(doc(fs, "users", user.uid, "settings", "main"));
    if (!s.exists()) await firstRun(user.uid);
  } catch (e) {
    if (e && e.code === "permission-denied") { gate(`<h1>${TX.title}</h1><p>${TX.denied}</p>`); return; }
    // offline on first open: carry on with the local cache
  }
  gate(null);
  const db = dbFor(user.uid);
  window.claude = { use: async n => (n === "db" ? db : n === "mcp" ? gcMcpObj : null) };
  window.HOME_ACCOUNT = { email: user.email, signOut: () => signOut(auth) };
  window.HOME_RESOLVE && window.HOME_RESOLVE();
});
