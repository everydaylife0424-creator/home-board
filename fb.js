/* HOME as a standalone app: Google sign-in + Firestore.
   index.html calls window.claude.use("db") just like inside claude.ai; this file supplies
   that object, backed by Firestore under users/<uid>/..., once Adam has signed in. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
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
getRedirectResult(auth).catch(e => showSignIn(TX.fail + ((e && e.code) || e)));

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
  window.claude = { use: async n => (n === "db" ? db : null) };
  window.HOME_ACCOUNT = { email: user.email, signOut: () => signOut(auth) };
  window.HOME_RESOLVE && window.HOME_RESOLVE();
});
