/* 股市模擬的雲端同步：沿用 HOME 的 Firebase 專案與 Google 登入，資料存在 users/<uid>/stocksim/state。 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCXDKyIVgIHCKCcdGbLQQvcvtdFBQcaKVE",
  authDomain: "home-board-bd604.firebaseapp.com",
  projectId: "home-board-bd604",
  storageBucket: "home-board-bd604.firebasestorage.app",
  messagingSenderId: "841192426427",
  appId: "1:841192426427:web:b3ca0f1310e4805896d29e",
};

export function createSync({ getState, onRemote, onStatus }) {
  const app = getApps()[0] || initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const fs = getFirestore(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  let ref = null, unsub = null, timer = null, email = "", ready = false;
  const status = (state, extra = {}) => onStatus({ state, email, ...extra });

  getRedirectResult(auth).catch(e => status("local", { err: "登入失敗：" + ((e && e.code) || e) }));

  onAuthStateChanged(auth, user => {
    if (unsub) { unsub(); unsub = null; }
    ready = false;
    if (!user) { ref = null; email = ""; status("local"); return; }
    email = user.email || "";
    ref = doc(fs, "users", user.uid, "stocksim", "state");
    status("signing");
    unsub = onSnapshot(ref, snap => {
      if (snap.metadata.hasPendingWrites) return;
      const local = getState();
      if (!snap.exists()) {
        setDoc(ref, clean(local)).catch(fail);
      } else {
        const remote = snap.data();
        // 第一次登入：雲端是空帳戶、這台裝置已經有交易 → 用這台的
        const remoteEmpty = !(remote.trades && remote.trades.length) && !(remote.orders && remote.orders.length);
        const localHas = local.trades && local.trades.length;
        if (!ready && remoteEmpty && localHas) setDoc(ref, clean(local)).catch(fail);
        else onRemote(remote);
      }
      ready = true;
      status("on");
    }, fail);
  });

  function fail(e) {
    if (e && e.code === "permission-denied") status("denied");
    else status("error", { err: "同步失敗：" + ((e && e.code) || e) });
  }
  function clean(s) { return JSON.parse(JSON.stringify(s)); }

  return {
    push(state) {
      if (!ref || !ready) return;
      clearTimeout(timer);
      timer = setTimeout(() => setDoc(ref, clean(state)).catch(fail), 600);
    },
    async signIn() {
      status("signing");
      try { await signInWithPopup(auth, provider); }
      catch (e) {
        if (e && (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment")) { await signInWithRedirect(auth, provider); return; }
        status("local", e && e.code === "auth/popup-closed-by-user" ? {} : { err: "登入失敗：" + ((e && e.code) || e) });
      }
    },
    signOut() { return signOut(auth); },
  };
}
