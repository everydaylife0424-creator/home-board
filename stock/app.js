/* 股市模擬：即時報價（證交所 MIS、Yahoo Finance，經由自己的 Apps Script 轉接站）＋模擬交易。
   資料存在瀏覽器（localStorage）；用 Google 登入後同步到 HOME 的 Firestore：users/<uid>/stocksim/state。 */
import { STOCKS } from "./stocks.js";

/* ---------- 設定 ---------- */
const PROXY_DEFAULT = "https://script.google.com/macros/s/AKfycbzTurnKOWD_n-ZEfWtJtuBJSQ5SR7058EHHv52WchdVF46oT87sgpq-cCg-lFIj8EYacw/exec"; // Apps Script 部署網址（…/exec）
const DEFAULT_WATCH = ["TW:2330", "TW:2317", "TW:2454", "TW:0050", "TW:2881", "US:NVDA", "US:AAPL", "US:TSM"];
const INDICES = [
  { k: "IDX:TWSE", n: "加權指數" }, 
  { k: "IDX:^GSPC", n: "S&P 500" }, { k: "IDX:^IXIC", n: "那斯達克" }, { k: "IDX:^SOX", n: "費城半導體" }, { k: "FX:USDTWD", n: "美元/台幣" },
];
const COLORS = ["#2f5d8a", "#c9822b", "#6a8f4e", "#9b5c8f", "#3f8f9b", "#b5534a", "#7a6cc4", "#8a8f3a", "#5a6b7d", "#c46a8e"];

/* ---------- 小工具 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const num = s => { const x = parseFloat(s); return Number.isFinite(x) ? x : null; };
const first = s => (s && typeof s === "string") ? num(s.split("_")[0]) : null;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const mkt = k => k.split(":")[0];
const code = k => k.slice(k.indexOf(":") + 1);
const ccyOf = k => (mkt(k) === "US" ? "USD" : "TWD");
const isETF = c => /^00/.test(c);
const NF = {};
const nf = (min, max) => (NF[min + "," + max] ||= new Intl.NumberFormat("zh-TW", { minimumFractionDigits: min, maximumFractionDigits: max }));
function pxDigits(k, v) {
  if (mkt(k) !== "TW") return 2;
  if (v == null) return 2;
  return v < 50 ? 2 : v < 500 ? 1 : 0;
}
const fmtPx = (k, v) => (v == null ? "—" : (mkt(k) === "TW" ? nf(pxDigits(k, v), 2) : nf(2, 2)).format(v));
const money = (v, ccy) => (v == null || !Number.isFinite(v) ? "—" : (ccy === "USD" ? "US$" + nf(2, 2).format(v) : "NT$" + nf(0, 0).format(Math.round(v))));
const signed = (v, f) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + f(Math.abs(v)));
const sMoney = (v, ccy) => signed(v, a => money(a, ccy));
const pct = v => (v == null || !Number.isFinite(v) ? "—" : signed(v * 100, a => nf(2, 2).format(a)) + "%");
const cls = v => (v == null || Math.abs(v) < 1e-9 ? "flat" : v > 0 ? "up" : "down");
const shares = n => nf(0, 4).format(n);
function tz(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(x => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { wd, min: (+p.hour % 24) * 60 + +p.minute, date: `${p.year}-${p.month}-${p.day}` };
}
const twNow = () => tz(new Date(), "Asia/Taipei");
const isOpen = m => {
  const t = m === "US" ? tz(new Date(), "America/New_York") : twNow();
  if (t.wd < 1 || t.wd > 5) return false;
  return m === "US" ? t.min >= 570 && t.min < 960 : t.min >= 540 && t.min <= 810;
};
const fmtTime = ms => {
  if (!ms) return "";
  const d = new Date(ms), same = d.toDateString() === new Date().toDateString();
  return d.toLocaleString("zh-TW", same ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
const fmtDate = ms => new Date(ms).toLocaleString("zh-TW", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200);
}

/* ---------- 狀態 ---------- */
function freshState(initTWD = 1_000_000, initUSD = 30_000, keep) {
  return {
    v: 1, created: Date.now(), updated: Date.now(),
    init: { TWD: initTWD, USD: initUSD }, cash: { TWD: initTWD, USD: initUSD }, realized: { TWD: 0, USD: 0 },
    pos: {}, trades: [], orders: [], hist: {},
    watch: keep?.watch || DEFAULT_WATCH.slice(),
    cfg: keep?.cfg || { disc: 1, minFee: 20, usFee: 0 },
  };
}
let S = LS.get("ss.state", null) || freshState();
let Q = LS.get("ss.q", {});        // 最新報價快取
let META = LS.get("ss.meta", {});  // 台股代號 → { ex: "tse" | "otc", n: 名稱 }
const NAMES = Object.fromEntries(STOCKS);
let sync = null;                   // 雲端同步模組（登入後）
let syncInfo = { state: "local" }; // local | signing | on | denied | error
let net = { ok: null, at: 0, err: "" };
let view = LS.get("ss.view", "market");
let wFilter = LS.get("ss.wf", "all");
let detail = null;                 // 目前打開的個股 { k, range }

function save(opts = {}) {
  S.updated = Date.now();
  LS.set("ss.state", S);
  if (sync && !opts.fromRemote) sync.push(S);
}
const nameOf = k => Q[k]?.name || META[code(k)]?.n || NAMES[k] || code(k);
const proxyUrl = () => (LS.get("ss.proxy", "") || PROXY_DEFAULT).trim();

/* ---------- 抓資料 ---------- */
async function fetchMany(urls) {
  const proxy = proxyUrl();
  if (!urls.length) return [];
  if (!proxy) {
    return Promise.all(urls.map(u => fetch(u).then(r => (r.ok ? r.text() : null)).catch(() => null)));
  }
  const chunks = [], out = [];
  let cur = [];
  for (const u of urls) {
    const next = [...cur, u];
    if (cur.length && (encodeURIComponent(JSON.stringify(next)).length > 1800 || next.length > 20)) { chunks.push(cur); cur = [u]; }
    else cur = next;
  }
  if (cur.length) chunks.push(cur);
  const res = await Promise.all(chunks.map(c =>
    fetch(proxy + (proxy.includes("?") ? "&" : "?") + "u=" + encodeURIComponent(JSON.stringify(c)))
      .then(r => r.json())
      .then(a => c.map((_, i) => (a[i] && a[i].s === 200 ? a[i].b : null)))
      .catch(() => c.map(() => null))));
  res.forEach(a => out.push(...a));
  return out;
}
const misUrl = list => "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&_=" + Date.now() + "&ex_ch=" + encodeURIComponent(list.join("|"));
function ySym(k) {
  if (k === "FX:USDTWD") return "TWD=X";
  if (k.startsWith("IDX:")) return code(k);
  if (mkt(k) === "US") return code(k);
  return code(k) + (META[code(k)]?.ex === "otc" ? ".TWO" : ".TW");
}
const yUrl = (k, range = "1d", interval = "5m") => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym(k))}?range=${range}&interval=${interval}&includePrePost=false`;

function parseMis(text) {
  const got = new Set();
  let j; try { j = JSON.parse(text); } catch { return got; }
  for (const m of j.msgArray || []) {
    const c = m.c; if (!c) continue;
    const key = c === "t00" ? "IDX:TWSE" : c === "o00" ? "IDX:OTC" : "TW:" + c;
    const old = Q[key];
    const prev = num(m.y);
    let last = num(m.z);
    const today = m.d;
    if (last == null) last = (old && old.day === today && old.last != null) ? old.last : (first(m.b) ?? first(m.a) ?? prev);
    Q[key] = {
      name: key.startsWith("IDX") ? undefined : m.n, last, prev,
      open: num(m.o), high: num(m.h), low: num(m.l), vol: num(m.v), unit: "張",
      up: num(m.u), dn: num(m.w), time: num(m.tlong) || Date.now(), day: today, src: "TWSE",
    };
    if (!key.startsWith("IDX")) META[c] = { ex: m.ex, n: m.n };
    got.add(c);
  }
  return got;
}
function parseYahoo(key, text) {
  let r; try { r = JSON.parse(text).chart.result[0]; } catch { return null; }
  if (!r || !r.meta) return null;
  const m = r.meta;
  const closes = r.indicators?.quote?.[0]?.close || [];
  const ts = r.timestamp || [];
  const pts = [];
  ts.forEach((t, i) => { if (closes[i] != null) pts.push([t * 1000, closes[i]]); });
  return { m, pts, period: m.currentTradingPeriod?.regular };
}
function applyYahoo(key, y) {
  const m = y.m;
  const last = m.regularMarketPrice ?? (y.pts.length ? y.pts[y.pts.length - 1][1] : null);
  if (last == null) return;
  const old = Q[key] || {};
  Q[key] = {
    ...old,
    name: key.startsWith("TW:") ? (old.name || META[code(key)]?.n || NAMES[key] || m.shortName) : (NAMES[key] || m.shortName || m.longName || code(key)),
    last, prev: m.chartPreviousClose ?? m.previousClose ?? old.prev,
    high: m.regularMarketDayHigh ?? old.high, low: m.regularMarketDayLow ?? old.low, vol: m.regularMarketVolume ?? old.vol, unit: "股",
    open: old.src === "Yahoo" || !old.open ? (y.pts[0]?.[1] ?? old.open) : old.open,
    time: (m.regularMarketTime || 0) * 1000 || Date.now(), src: "Yahoo",
  };
}

function neededKeys() {
  const ks = new Set([...S.watch, ...Object.keys(S.pos), ...S.orders.map(o => o.k)]);
  if (detail) ks.add(detail.k);
  return [...ks];
}
let inflight = null, timer = null;
function refresh() {
  if (!inflight) inflight = doRefresh().finally(() => { inflight = null; render(); schedule(); });
  return inflight;
}
async function doRefresh() {
  {
    const keys = neededKeys();
    const tw = keys.filter(k => mkt(k) === "TW").map(code);
    const us = keys.filter(k => mkt(k) === "US");
    const yKeys = [...us, "IDX:^GSPC", "IDX:^IXIC", "IDX:^SOX", "FX:USDTWD"];
    const misLists = [];
    const ex = ["tse_t00.tw"];
    for (const c of tw) { const e = META[c]?.ex; if (e) ex.push(`${e}_${c}.tw`); else ex.push(`tse_${c}.tw`, `otc_${c}.tw`); }
    for (let i = 0; i < ex.length; i += 40) misLists.push(ex.slice(i, i + 40));
    const urls = [...misLists.map(misUrl), ...yKeys.map(k => yUrl(k))];
    const res = await fetchMany(urls);
    let ok = 0;
    const got = new Set();
    misLists.forEach((_, i) => { if (res[i]) { const g = parseMis(res[i]); if (g.size) { ok++; g.forEach(c => got.add(c)); } } });
    yKeys.forEach((k, i) => { const t = res[misLists.length + i]; const y = t && parseYahoo(k, t); if (y) { applyYahoo(k, y); ok++; } });
    // 證交所偶爾沒回應：沒拿到的台股和指數改用 Yahoo 補
    const miss = tw.filter(c => !got.has(c)).map(c => "TW:" + c);
    const missIdx = [["t00", "IDX:TWSE", "^TWII"]].filter(x => !got.has(x[0]));
    if (miss.length || missIdx.length) {
      const r2 = await fetchMany([...miss.map(k => yUrl(k)), ...missIdx.map(x => yUrl("IDX:" + x[2]))]);
      miss.forEach((k, i) => { const y = r2[i] && parseYahoo(k, r2[i]); if (y) { applyYahoo(k, y); ok++; } });
      missIdx.forEach((x, i) => { const t = r2[miss.length + i]; const y = t && parseYahoo(x[1], t); if (y) { applyYahoo(x[1], y); ok++; } });
    }
    net = ok ? { ok: true, at: Date.now() } : { ok: false, at: net.at, err: proxyUrl() ? "轉接站沒有回應" : "尚未設定報價轉接站" };
    if (ok) { LS.set("ss.q", Q); LS.set("ss.meta", META); }
    if (ok) { processOrders(); recordHist(); }
  }
}
function schedule() {
  clearTimeout(timer);
  const live = isOpen("TW") || isOpen("US");
  timer = setTimeout(() => { if (!document.hidden) refresh(); else schedule(); }, live ? 10000 : 60000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

/* ---------- 交易 ---------- */
function costs(k, side, qty, price) {
  const cfg = S.cfg;
  if (mkt(k) === "US") {
    const amount = Math.round(price * qty * 100) / 100;
    return { amount, fee: +cfg.usFee || 0, tax: 0 };
  }
  const amount = Math.round(price * qty);
  const fee = Math.max(+cfg.minFee || 0, Math.floor(amount * 0.001425 * (+cfg.disc || 1)));
  const tax = side === "sell" ? Math.floor(amount * (isETF(code(k)) ? 0.001 : 0.003)) : 0;
  return { amount, fee, tax };
}
const reserved = ccy => S.orders.filter(o => o.side === "buy" && ccyOf(o.k) === ccy).reduce((a, o) => { const c = costs(o.k, "buy", o.qty, o.limit); return a + c.amount + c.fee; }, 0);
const pendingSell = k => S.orders.filter(o => o.side === "sell" && o.k === k).reduce((a, o) => a + o.qty, 0);
const availCash = ccy => S.cash[ccy] - reserved(ccy);
const availQty = k => (S.pos[k]?.qty || 0) - pendingSell(k);

function fill(k, side, qty, price, how) {
  const ccy = ccyOf(k), c = costs(k, side, qty, price);
  const t = { id: uid(), t: Date.now(), k, name: nameOf(k), side, qty, price, ...c, ccy, how, closed: !isOpen(mkt(k)) };
  if (side === "buy") {
    const total = c.amount + c.fee;
    if (total > S.cash[ccy] + 1e-6) return { err: "現金不足" };
    S.cash[ccy] -= total;
    const p = S.pos[k] ||= { qty: 0, cost: 0, name: nameOf(k), since: Date.now() };
    p.qty += qty; p.cost += total; p.name = nameOf(k);
  } else {
    const p = S.pos[k];
    if (!p || p.qty < qty) return { err: "持股不足" };
    const proceeds = c.amount - c.fee - c.tax;
    const basis = p.cost / p.qty * qty;
    t.pnl = proceeds - basis;
    t.basis = basis;
    p.cost -= basis; p.qty -= qty;
    if (p.qty <= 1e-9) delete S.pos[k];
    S.cash[ccy] += proceeds;
    S.realized[ccy] = (S.realized[ccy] || 0) + t.pnl;
  }
  if (ccy === "USD") S.cash.USD = Math.round(S.cash.USD * 100) / 100;
  S.trades.unshift(t);
  if (S.trades.length > 3000) S.trades.length = 3000;
  return { t };
}
function placeOrder({ k, side, qty, type, limit, manual }) {
  if (!(qty > 0)) return { err: "請輸入數量" };
  if (mkt(k) === "TW" && !Number.isInteger(qty)) return { err: "台股以「股」為單位，請輸入整數" };
  const ccy = ccyOf(k), q = Q[k], last = q?.last;
  const px = manual ? limit : type === "market" ? last : limit;
  if (!(px > 0)) return { err: type === "market" ? "目前沒有報價，請改用限價" : "請輸入價格" };
  if (side === "buy") {
    const c = costs(k, "buy", qty, px);
    if (c.amount + c.fee > availCash(ccy) + 1e-6) return { err: `可用現金不足（可用 ${money(availCash(ccy), ccy)}）` };
  } else if (qty > availQty(k) + 1e-9) return { err: `可賣股數不足（可賣 ${shares(availQty(k))} 股）` };

  if (manual || type === "market") { const r = fill(k, side, qty, px, manual ? "手動價" : "市價"); if (!r.err) save(); return r; }
  // 限價：價格已經到了就立刻成交（以目前價格），否則掛單等待
  if (last != null && isOpen(mkt(k)) && ((side === "buy" && last <= limit) || (side === "sell" && last >= limit))) {
    const r = fill(k, side, qty, last, "限價"); if (!r.err) save(); return r;
  }
  const o = { id: uid(), t: Date.now(), k, name: nameOf(k), side, qty, limit };
  S.orders.push(o); save();
  return { order: o };
}
function processOrders() {
  let changed = false;
  for (const o of [...S.orders]) {
    const q = Q[o.k];
    if (!q || q.last == null || !isOpen(mkt(o.k)) || Date.now() - (q.time || 0) > 15 * 60000) continue;
    const hit = o.side === "buy" ? q.last <= o.limit : q.last >= o.limit;
    if (!hit) continue;
    S.orders = S.orders.filter(x => x.id !== o.id);
    const r = fill(o.k, o.side, o.qty, o.side === "buy" ? Math.min(q.last, o.limit) : Math.max(q.last, o.limit), "限價");
    toast(r.err ? `限價單取消：${o.name} ${r.err}` : `限價單成交：${o.side === "buy" ? "買進" : "賣出"} ${o.name} ${shares(o.qty)} 股 @ ${fmtPx(o.k, r.t.price)}`);
    changed = true;
  }
  if (changed) save();
}

/* ---------- 估值 ---------- */
const fx = () => Q["FX:USDTWD"]?.last || LS.get("ss.fx", 32);
function valuation() {
  const v = { mv: { TWD: 0, USD: 0 }, cost: { TWD: 0, USD: 0 }, day: { TWD: 0, USD: 0 }, rows: [], complete: true };
  for (const [k, p] of Object.entries(S.pos)) {
    const q = Q[k], ccy = ccyOf(k);
    const last = q?.last ?? p.cost / p.qty;
    if (q?.last == null) v.complete = false;
    const mv = last * p.qty;
    v.mv[ccy] += mv; v.cost[ccy] += p.cost;
    let dayChg = 0;
    if (q?.prev != null && q?.last != null) {
      // 今天才買進／賣出的部分，以成交價而不是昨收計算今日損益
      const today = tz(new Date(), mkt(k) === "US" ? "America/New_York" : "Asia/Taipei").date;
      let qtyPrev = p.qty, net = 0;
      for (const t of S.trades) {
        if (t.k !== k) continue;
        if (tz(new Date(t.t), mkt(k) === "US" ? "America/New_York" : "Asia/Taipei").date !== today) break;
        if (t.side === "buy") { qtyPrev -= t.qty; net += t.amount; } else { qtyPrev += t.qty; net -= t.amount; }
      }
      dayChg = p.qty * q.last - Math.max(0, qtyPrev) * q.prev - net;
    }
    v.day[ccy] += dayChg;
    v.rows.push({ k, p, q, ccy, last, mv, avg: p.cost / p.qty, pnl: mv - p.cost, pnlPct: p.cost ? (mv - p.cost) / p.cost : 0, dayChg });
  }
  const r = fx();
  v.fx = r;
  v.total = S.cash.TWD + v.mv.TWD + (S.cash.USD + v.mv.USD) * r;
  v.init = S.init.TWD + S.init.USD * r;
  v.pnl = v.total - v.init;
  v.dayTotal = v.day.TWD + v.day.USD * r;
  v.rows.sort((a, b) => (b.mv * (b.ccy === "USD" ? r : 1)) - (a.mv * (a.ccy === "USD" ? r : 1)));
  return v;
}
function recordHist() {
  if (Q["FX:USDTWD"]?.last) LS.set("ss.fx", Q["FX:USDTWD"].last);
  const v = valuation();
  if (!v.complete) return;
  const d = twNow().date;
  const val = Math.round(v.total);
  if (S.hist[d] === val) return;
  S.hist[d] = val;
  const ks = Object.keys(S.hist).sort();
  if (ks.length > 800) for (const x of ks.slice(0, ks.length - 800)) delete S.hist[x];
  save();
}

/* ---------- 圖示 ---------- */
const ICON = {
  market: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/></svg>',
  port: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/></svg>',
  hist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
  set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  star: f => `<svg viewBox="0 0 24 24" fill="${f ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>`,
};
const TABS = [["market", "市場"], ["port", "持股"], ["hist", "紀錄"], ["set", "設定"]];

/* ---------- 畫面 ---------- */
function setView(v) {
  view = v; LS.set("ss.view", v);
  for (const [id] of TABS) $("#v-" + id).hidden = id !== v;
  render();
  window.scrollTo({ top: 0 });
}
function renderTabs() {
  const html = TABS.map(([id, n]) => `<button type="button" data-tab="${id}" aria-current="${id === view}">${ICON[id]}<span>${n}</span></button>`).join("");
  const top = TABS.map(([id, n]) => `<button type="button" data-tab="${id}" aria-current="${id === view}">${n}</button>`).join("");
  $("#tabsBottom").innerHTML = html; $("#tabsTop").innerHTML = top;
}
function renderStatus() {
  const tw = isOpen("TW"), us = isOpen("US");
  const mk = tw && us ? "台股、美股交易中" : tw ? "台股交易中" : us ? "美股交易中" : "休市中";
  let s;
  if (net.ok === null) s = "連線中…";
  else if (!net.ok) s = `<span class="dot"></span>${esc(net.err)}`;
  else s = `<span class="dot ${tw || us ? "on" : ""}"></span>${mk} · ${fmtTime(net.at)} 更新`;
  $("#status").innerHTML = s;
  const a = $("#acct");
  a.textContent = syncInfo.state === "on" ? "已同步" : syncInfo.state === "signing" ? "登入中…" : "本機";
  a.title = syncInfo.email || "";
}
function render() {
  renderTabs(); renderStatus();
  if (view === "market") renderMarket();
  if (view === "port") renderPort();
  if (view === "hist") renderHist();
  if (view === "set") renderSet();
  if (detail) renderDetail(false);
}

function quoteRow(k) {
  const q = Q[k], chg = q?.last != null && q?.prev ? q.last - q.prev : null, p = chg != null ? chg / q.prev : null;
  const held = S.pos[k];
  return `<button type="button" class="row" data-open="${esc(k)}">
    <span class="nm"><b>${esc(nameOf(k))}</b><small><span class="tag">${mkt(k) === "US" ? "美" : META[code(k)]?.ex === "otc" ? "櫃" : "台"}</span> ${esc(code(k))}${held ? ` · 持有 ${shares(held.qty)} 股` : ""}</small></span>
    <span class="px">${fmtPx(k, q?.last)}<small class="${cls(chg)}">${chg == null ? "" : signed(chg, a => fmtPx(k, a))}</small></span>
    <span class="chip ${cls(chg)}">${pct(p)}</span>
  </button>`;
}
function bannerHtml() {
  if (net.ok !== false) return "";
  if (!proxyUrl()) return `<div class="banner"><b>還看不到即時報價</b>報價轉接站還沒設定，等設定好之後這裡就會自動顯示股價。在那之前仍然可以練習下單，成交價要自己輸入。</div>`;
  return `<div class="banner"><b>暫時抓不到報價</b>轉接站沒有回應，會每分鐘自動重試。畫面上是最後一次成功抓到的價格。</div>`;
}
function renderMarket() {
  const el = $("#v-market");
  const idx = INDICES.map(({ k, n }) => {
    const q = Q[k], chg = q?.last != null && q?.prev ? q.last - q.prev : null;
    return `<div class="t"><small>${n}</small><div class="v">${q?.last != null ? nf(2, 2).format(q.last) : "—"}</div><div class="c ${cls(chg)}">${chg == null ? "&nbsp;" : signed(chg, a => nf(2, 2).format(a)) + "（" + pct(chg / q.prev) + "）"}</div></div>`;
  }).join("");
  const list = S.watch.filter(k => wFilter === "all" || mkt(k) === wFilter);
  const searchVal = $("#q")?.value || "";
  const hadFocus = document.activeElement?.id === "q";
  if (!$("#q")) {
    el.innerHTML = `<div id="mBanner"></div><div class="idx" id="mIdx"></div>
      <div class="search">${ICON.search}<input id="q" type="search" placeholder="搜尋代號或名稱，例如 2330、台積電、NVDA" autocomplete="off" enterkeyhint="search"><div class="sugg" id="sugg" hidden></div></div>
      <div class="card"><h2>自選股<span class="sp"></span><span class="seg" id="wseg"></span></h2><div class="rows" id="wlist"></div></div>
      <p class="note">台股報價來自臺灣證券交易所，美股與指數來自 Yahoo Finance，交易時間約每 10 秒更新一次。顏色依台灣習慣：紅色漲、綠色跌。</p>`;
  }
  $("#mBanner").innerHTML = bannerHtml();
  $("#mIdx").innerHTML = idx;
  $("#wseg").innerHTML = [["all", "全部"], ["TW", "台股"], ["US", "美股"]].map(([v, n]) => `<button type="button" data-wf="${v}" aria-pressed="${wFilter === v}">${n}</button>`).join("");
  $("#wlist").innerHTML = list.length ? list.map(quoteRow).join("") : `<div class="empty">還沒有自選股，用上方搜尋加入。</div>`;
  if (hadFocus) $("#q").value = searchVal;
}

function suggest(qs) {
  const s = qs.trim(); if (!s) return [];
  const u = s.toUpperCase();
  const out = [];
  for (const [k, n] of STOCKS) {
    if (code(k).toUpperCase().startsWith(u) || n.toUpperCase().includes(u)) out.push(k);
    if (out.length >= 8) break;
  }
  for (const [c, m] of Object.entries(META)) {
    if (out.length >= 8) break;
    if ((c.startsWith(u) || (m.n || "").includes(s)) && !out.includes("TW:" + c)) out.push("TW:" + c);
  }
  if (/^\d{4,6}[A-Z]?$/.test(u) && !out.includes("TW:" + u)) out.unshift("TW:" + u);
  else if (/^[A-Z][A-Z.\-]{0,6}$/.test(u) && !out.includes("US:" + u.replace(".", "-"))) out.push("US:" + u.replace(".", "-"));
  return out.slice(0, 9);
}
function renderSugg() {
  const inp = $("#q"), box = $("#sugg");
  const ks = suggest(inp.value);
  if (!ks.length) { box.hidden = true; return; }
  box.innerHTML = ks.map((k, i) => `<button type="button" data-open="${esc(k)}" class="${i === 0 ? "on" : ""}"><span class="tag">${mkt(k) === "US" ? "美股" : "台股"}</span><b>${esc(code(k))}</b><span class="muted">${esc(NAMES[k] || META[code(k)]?.n || Q[k]?.name || "查詢這個代號")}</span></button>`).join("");
  box.hidden = false;
}

function renderPort() {
  const el = $("#v-port"), v = valuation();
  const r = v.fx;
  const parts = [["現金（台幣）", S.cash.TWD], ["現金（美元）", S.cash.USD * r], ...v.rows.map(x => [nameOf(x.k), x.mv * (x.ccy === "USD" ? r : 1)])].filter(x => x[1] > 0.5);
  const tot = parts.reduce((a, x) => a + x[1], 0) || 1;
  const alloc = parts.map((x, i) => `<i style="width:${(x[1] / tot * 100).toFixed(2)}%;background:${COLORS[i % COLORS.length]}"></i>`).join("");
  const legend = parts.map((x, i) => `<span style="--c:${COLORS[i % COLORS.length]}">${esc(x[0])} ${(x[1] / tot * 100).toFixed(1)}%</span>`).join("");
  const realizedTot = (S.realized.TWD || 0) + (S.realized.USD || 0) * r;
  const hist = Object.entries(S.hist).sort((a, b) => a[0] < b[0] ? -1 : 1);

  const table = v.rows.length ? `<div class="hold-table scrollx"><table class="tbl"><thead><tr><th>股票</th><th class="n">股數</th><th class="n">平均成本</th><th class="n">現價</th><th class="n">今日</th><th class="n">市值</th><th class="n">未實現損益</th></tr></thead><tbody>
    ${v.rows.map(x => `<tr class="click" data-open="${esc(x.k)}"><td><b>${esc(nameOf(x.k))}</b><br><small class="muted">${esc(code(x.k))}</small></td>
      <td class="n">${shares(x.p.qty)}</td><td class="n">${fmtPx(x.k, x.avg)}</td><td class="n">${fmtPx(x.k, x.q?.last)}</td>
      <td class="n ${cls(x.dayChg)}">${sMoney(x.dayChg, x.ccy)}</td><td class="n">${money(x.mv, x.ccy)}</td>
      <td class="n ${cls(x.pnl)}">${sMoney(x.pnl, x.ccy)}<br><small>${pct(x.pnlPct)}</small></td></tr>`).join("")}
    </tbody></table></div>
    <div class="hold-cards">${v.rows.map(x => `<button type="button" class="hc" data-open="${esc(x.k)}">
      <div class="h"><span><b>${esc(nameOf(x.k))}</b> <small class="muted">${esc(code(x.k))} · ${shares(x.p.qty)} 股</small></span><b class="${cls(x.pnl)}">${pct(x.pnlPct)}</b></div>
      <div class="g"><div><small>平均成本</small><span>${fmtPx(x.k, x.avg)}</span></div><div><small>現價</small><span>${fmtPx(x.k, x.q?.last)}</span></div><div><small>市值</small><span>${money(x.mv, x.ccy)}</span></div>
      <div><small>今日</small><span class="${cls(x.dayChg)}">${sMoney(x.dayChg, x.ccy)}</span></div><div><small>未實現損益</small><span class="${cls(x.pnl)}">${sMoney(x.pnl, x.ccy)}</span></div><div><small>成本</small><span>${money(x.p.cost, x.ccy)}</span></div></div>
    </button>`).join("")}</div>` : `<div class="empty">目前沒有持股。到「市場」點一檔股票就能下單。</div>`;

  const orders = S.orders.length ? `<div class="card"><h2>掛單中的限價單</h2><table class="tbl"><tbody>${S.orders.map(o => `<tr>
      <td><b class="${o.side === "buy" ? "up" : "down"}">${o.side === "buy" ? "買" : "賣"}</b> ${esc(o.name)} <small class="muted">${esc(code(o.k))}</small><br><small class="muted">${fmtDate(o.t)}</small></td>
      <td class="n">${shares(o.qty)} 股<br><small>@ ${fmtPx(o.k, o.limit)}</small></td>
      <td class="n"><button type="button" class="btn sm" data-cancel="${o.id}">取消</button></td></tr>`).join("")}</tbody></table>
      <p class="note">限價單在交易時間內、價格到達時自動成交；需要這個網頁開著才會檢查。</p></div>` : "";

  el.innerHTML = `${bannerHtml()}
  <div class="grid2">
    <div class="card sum">
      <div><small class="muted">總資產（約當台幣，匯率 ${nf(2, 3).format(r)}）</small><div class="big">${money(v.total, "TWD")}</div>
        <div class="${cls(v.pnl)}">${sMoney(v.pnl, "TWD")}（${pct(v.pnl / v.init)}）<span class="muted"> 自開戶以來</span></div></div>
      <div class="kv">
        <div><small>今日損益</small><b class="${cls(v.dayTotal)}">${sMoney(v.dayTotal, "TWD")}</b></div>
        <div><small>已實現損益</small><b class="${cls(realizedTot)}">${sMoney(realizedTot, "TWD")}</b></div>
        <div><small>台股市值</small><b>${money(v.mv.TWD, "TWD")}</b></div>
        <div><small>美股市值</small><b>${money(v.mv.USD, "USD")}</b></div>
        <div><small>可用台幣</small><b>${money(availCash("TWD"), "TWD")}</b></div>
        <div><small>可用美元</small><b>${money(availCash("USD"), "USD")}</b></div>
      </div>
      <div class="alloc">${alloc}</div><div class="legend">${legend}</div>
    </div>
    <div class="card"><h2>資產走勢</h2>${hist.length >= 2 ? `<div class="chart" id="eqChart"></div>` : `<div class="empty">每天開網頁時會記下總資產，累積兩天以上就會畫出走勢。</div>`}</div>
  </div>
  <div class="card"><h2>持股<span class="sp"></span><small class="muted">${v.rows.length} 檔</small></h2>${table}</div>
  ${orders}`;
  if (hist.length >= 2) {
    const pts = hist.map(([d, val]) => [new Date(d + "T12:00:00+08:00").getTime(), val]);
    drawChart($("#eqChart"), { pts, ref: v.init, fmt: x => money(x, "TWD"), tfmt: t => new Date(t).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" }) });
  }
}

function renderHist() {
  const el = $("#v-hist");
  const f = LS.get("ss.hf", "all");
  const list = S.trades.filter(t => f === "all" || (f === "sell" ? t.side === "sell" : f === "buy" ? t.side === "buy" : mkt(t.k) === f));
  const sells = S.trades.filter(t => t.side === "sell");
  const wins = sells.filter(t => t.pnl > 0).length;
  const fees = { TWD: 0, USD: 0 };
  S.trades.forEach(t => { fees[t.ccy] += (t.fee || 0) + (t.tax || 0); });
  el.innerHTML = `<div class="card"><h2>交易紀錄<span class="sp"></span><span class="seg" id="hseg">${[["all", "全部"], ["buy", "買進"], ["sell", "賣出"], ["TW", "台股"], ["US", "美股"]].map(([v, n]) => `<button type="button" data-hf="${v}" aria-pressed="${f === v}">${n}</button>`).join("")}</span></h2>
    <div class="kv" style="margin-bottom:12px">
      <div><small>交易次數</small><b>${S.trades.length}</b></div>
      <div><small>賣出勝率</small><b>${sells.length ? Math.round(wins / sells.length * 100) + "%" : "—"}</b></div>
      <div><small>台股手續費＋稅</small><b>${money(fees.TWD, "TWD")}</b></div>
      <div><small>美股手續費</small><b>${money(fees.USD, "USD")}</b></div>
    </div>
    ${list.length ? `<div class="scrollx"><table class="tbl"><thead><tr><th>時間</th><th>股票</th><th class="n">股數 × 價格</th><th class="n">費用</th><th class="n">收付金額</th><th class="n">損益</th></tr></thead><tbody>
    ${list.map(t => `<tr class="click" data-open="${esc(t.k)}"><td><small>${fmtDate(t.t)}</small><br><small class="muted">${esc(t.how)}${t.closed ? "・休市" : ""}</small></td>
      <td><b class="${t.side === "buy" ? "up" : "down"}">${t.side === "buy" ? "買" : "賣"}</b> ${esc(t.name)}<br><small class="muted">${esc(code(t.k))}</small></td>
      <td class="n">${shares(t.qty)} × ${fmtPx(t.k, t.price)}</td>
      <td class="n">${money(t.fee + (t.tax || 0), t.ccy)}${t.tax ? `<br><small class="muted">含稅 ${money(t.tax, t.ccy)}</small>` : ""}</td>
      <td class="n">${t.side === "buy" ? "−" + money(t.amount + t.fee, t.ccy) : "+" + money(t.amount - t.fee - t.tax, t.ccy)}</td>
      <td class="n ${cls(t.pnl)}">${t.side === "sell" ? sMoney(t.pnl, t.ccy) : ""}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">還沒有交易。</div>`}
    ${S.trades.length ? `<div class="flex" style="margin-top:12px"><button type="button" class="btn sm" id="csv">匯出 CSV</button></div>` : ""}
  </div>`;
}

function renderSet() {
  const el = $("#v-set");
  if (el.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return; // 打字時不要重畫
  const c = S.cfg;
  const acc = syncInfo.state === "on" ? `<p>已用 <b>${esc(syncInfo.email || "Google 帳號")}</b> 登入，投資組合會在所有裝置同步（和 HOME 用同一個帳號）。</p><div class="flex"><button type="button" class="btn" id="signOut">登出</button></div>`
    : syncInfo.state === "denied" ? `<p class="warn">雲端資料庫拒絕存取，目前只存在這台裝置。</p>`
    : syncInfo.state === "signing" ? `<p>登入中…</p>`
    : `<p>目前資料只存在這台裝置。用 Google 登入後，手機、iPad、電腦都能看到同一個投資組合。</p><div class="flex"><button type="button" class="btn primary" id="signIn">用 Google 登入同步</button></div>${syncInfo.err ? `<p class="warn">${esc(syncInfo.err)}</p>` : ""}`;
  const discOpts = [[1, "原價（1.425‰）"], [0.6, "6 折"], [0.5, "5 折"], [0.38, "3.8 折"], [0.28, "2.8 折"], [0.2, "2 折"]];
  el.innerHTML = `<div class="settings">
    <div class="card"><h2>帳號與同步</h2>${acc}</div>
    <div class="card"><h2>交易成本</h2>
      <div class="settings">
        <label class="field"><span>台股手續費折扣</span><select id="cDisc">${discOpts.map(([v, n]) => `<option value="${v}" ${+c.disc === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="field"><span>台股最低手續費（元）</span><input id="cMin" type="number" inputmode="numeric" min="0" step="1" value="${c.minFee}"></label>
        <label class="field"><span>美股每筆手續費（美元）</span><input id="cUs" type="number" inputmode="decimal" min="0" step="0.01" value="${c.usFee}"></label>
        <p class="note">台股證交稅：股票 0.3%、ETF 0.1%，賣出時收取。沒有模擬當沖減半、融資融券和配息。</p>
        <div class="flex"><button type="button" class="btn" id="saveCfg">儲存交易成本</button></div>
      </div></div>
    <div class="card"><h2>重新開始</h2>
      <p class="note">清掉所有持股、掛單和交易紀錄，用新的資金重新開始。自選股會保留。</p>
      <div class="settings">
        <label class="field"><span>台幣資金</span><input id="rTWD" type="number" inputmode="numeric" min="0" step="10000" value="${S.init.TWD}"></label>
        <label class="field"><span>美元資金</span><input id="rUSD" type="number" inputmode="numeric" min="0" step="1000" value="${S.init.USD}"></label>
        <div class="flex"><button type="button" class="btn danger" id="reset">重設帳戶</button></div>
      </div></div>
    <div class="card"><h2>報價來源</h2>
      <p class="note">報價經由你自己的 Google Apps Script 轉接站抓取（網頁不能直接連到證交所和 Yahoo）。一般不需要改這裡。</p>
      <label class="field"><span>轉接站網址</span><input id="proxy" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(LS.get("ss.proxy", "") || "")}"></label>
      <p class="note">${PROXY_DEFAULT ? "留空會使用內建的轉接站。" : ""}目前狀態：${net.ok ? "正常" : esc(net.err || "連線中")}</p>
      <div class="flex"><button type="button" class="btn" id="saveProxy">儲存並重新抓取</button></div>
    </div>
  </div>`;
}

/* ---------- 個股頁 ---------- */
const RANGES = [["1d", "5m", "1日"], ["5d", "15m", "5日"], ["1mo", "1d", "1月"], ["6mo", "1d", "6月"], ["1y", "1d", "1年"], ["5y", "1wk", "5年"]];
const chartCache = {};
function openDetail(k) {
  detail = { k, range: "1d", side: "buy", type: "market" };
  $("#sheetBg").hidden = false; $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
  renderDetail(true);
  if (mkt(k) === "TW" && !META[code(k)]) refresh().then(loadChart); // 先確認是上市還是上櫃，才知道 Yahoo 代號
  else { loadChart(); if (!Q[k]) refresh(); }
}
function closeDetail() {
  detail = null; $("#sheetBg").hidden = true; $("#sheet").hidden = true; document.body.style.overflow = "";
  $("#sheet").innerHTML = "";
}
async function loadChart() {
  if (!detail) return;
  const { k, range } = detail;
  const r = RANGES.find(x => x[0] === range);
  const ck = ySym(k) + "|" + range;
  const c = chartCache[ck];
  if (!c || Date.now() - c.at > (range === "1d" ? 30000 : 300000)) {
    const [t] = await fetchMany([yUrl(k, r[0], r[1])]);
    const y = t && parseYahoo(k, t);
    chartCache[ck] = { at: Date.now(), y, fail: !y };
  }
  if (detail && detail.k === k && detail.range === range) drawDetailChart();
}
function drawDetailChart() {
  const box = $("#dChart"); if (!box || !detail) return;
  const { k, range } = detail;
  const c = chartCache[ySym(k) + "|" + range];
  if (!c) { box.innerHTML = `<div class="msg">載入走勢圖…</div>`; return; }
  if (c.fail || !c.y || c.y.pts.length < 2) { box.innerHTML = `<div class="msg">${net.ok === false ? "沒有報價連線，暫時無法顯示走勢圖" : "沒有走勢資料"}</div>`; return; }
  const q = Q[k];
  let pts = c.y.pts.slice();
  let ref = pts[0][1], domain = null;
  if (range === "1d") {
    ref = q?.prev ?? c.y.m.chartPreviousClose ?? ref;
    if (c.y.period) domain = [c.y.period.start * 1000, c.y.period.end * 1000];
    if (q?.last != null && isOpen(mkt(k))) pts.push([Math.max(pts[pts.length - 1][0], Math.min(Date.now(), domain ? domain[1] : Date.now())), q.last]);
  }
  const tfmt = range === "1d" || range === "5d"
    ? t => new Date(t).toLocaleString("zh-TW", { ...(range === "5d" ? { month: "numeric", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit", hour12: false, timeZone: mkt(k) === "US" ? "America/New_York" : "Asia/Taipei" })
    : t => new Date(t).toLocaleDateString("zh-TW", { year: range === "5y" ? "numeric" : undefined, month: "numeric", day: "numeric" });
  drawChart(box, { pts, ref, domain, dashed: range === "1d", fmt: x => fmtPx(k, x), tfmt });
}

function drawChart(box, { pts, ref, domain, dashed, fmt, tfmt }) {
  const W = Math.max(200, box.clientWidth), H = box.clientHeight || 220, padR = 58, padT = 22, padB = 18;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = domain ? domain[0] : xs[0], x1 = domain ? Math.max(domain[1], xs[xs.length - 1]) : xs[xs.length - 1];
  let lo = Math.min(...ys, ref ?? Infinity), hi = Math.max(...ys, ref ?? -Infinity);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const sx = t => ((t - x0) / (x1 - x0 || 1)) * (W - padR);
  const sy = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const lastV = ys[ys.length - 1];
  const col = ref == null || Math.abs(lastV - ref) < 1e-9 ? "var(--flat)" : lastV > ref ? "var(--up)" : "var(--down)";
  const d = pts.map((p, i) => (i ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1)).join("");
  const area = d + `L${sx(xs[xs.length - 1]).toFixed(1)} ${H - padB}L${sx(xs[0]).toFixed(1)} ${H - padB}Z`;
  const gid = "g" + Math.random().toString(36).slice(2, 7);
  const ticks = [hi - pad, (hi + lo) / 2, lo + pad];
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".18"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map(v => `<line x1="0" x2="${W - padR}" y1="${sy(v)}" y2="${sy(v)}" stroke="var(--line)" stroke-width="1"/><text x="${W - padR + 6}" y="${sy(v) + 4}" font-size="11" fill="var(--muted)">${esc(fmt(v))}</text>`).join("")}
    ${ref != null ? `<line x1="0" x2="${W - padR}" y1="${sy(ref)}" y2="${sy(ref)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="${dashed ? "3 4" : "1 0"}" opacity=".7"/>` : ""}
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/>
    <text x="0" y="${H - 3}" font-size="11" fill="var(--muted)">${esc(tfmt(x0))}</text>
    <text x="${W - padR}" y="${H - 3}" font-size="11" fill="var(--muted)" text-anchor="end">${esc(tfmt(x1))}</text>
    <g class="cross" style="display:none"><line y1="${padT - 6}" y2="${H - padB}" stroke="var(--muted)" stroke-width="1"/><circle r="4" fill="${col}" stroke="var(--surface)" stroke-width="2"/></g>
  </svg><div class="tip" style="display:none"></div>`;
  const svg = box.querySelector("svg"), g = box.querySelector(".cross"), tip = box.querySelector(".tip");
  const move = e => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * (W / r.width);
    let bi = 0, bd = Infinity;
    pts.forEach((p, i) => { const dd = Math.abs(sx(p[0]) - x); if (dd < bd) { bd = dd; bi = i; } });
    const p = pts[bi], px = sx(p[0]), py = sy(p[1]);
    g.style.display = ""; g.querySelector("line").setAttribute("x1", px); g.querySelector("line").setAttribute("x2", px);
    g.querySelector("circle").setAttribute("cx", px); g.querySelector("circle").setAttribute("cy", py);
    const chg = ref ? ` (${pct((p[1] - ref) / ref)})` : "";
    tip.style.display = ""; tip.textContent = `${tfmt(p[0])}  ${fmt(p[1])}${chg}`;
    const tw = tip.offsetWidth, left = Math.min(Math.max(px / W * r.width, tw / 2), r.width - tw / 2);
    tip.style.left = left + "px";
  };
  const leave = () => { g.style.display = "none"; tip.style.display = "none"; };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", leave); svg.addEventListener("pointerup", e => { if (e.pointerType !== "mouse") leave(); });
}

function orderEstimate() {
  if (!detail) return;
  const { k } = detail, f = $("#oForm"); if (!f) return;
  const q = Q[k], qty = +$("#oQty").value || 0;
  const manual = q?.last == null;
  const type = manual ? "limit" : detail.type;
  const price = type === "market" ? q?.last : +$("#oPx").value || 0;
  const ccy = ccyOf(k), side = detail.side;
  const c = price > 0 && qty > 0 ? costs(k, side, qty, price) : null;
  const total = c ? (side === "buy" ? c.amount + c.fee : c.amount - c.fee - c.tax) : null;
  $("#oEst").innerHTML = `
    <div><span>成交金額${type === "market" ? "（以現價估算）" : ""}</span><span>${c ? money(c.amount, ccy) : "—"}</span></div>
    <div><span>手續費</span><span>${c ? money(c.fee, ccy) : "—"}</span></div>
    ${side === "sell" && ccy === "TWD" ? `<div><span>證交稅（${isETF(code(k)) ? "0.1" : "0.3"}%）</span><span>${c ? money(c.tax, ccy) : "—"}</span></div>` : ""}
    <div class="tot"><span>${side === "buy" ? "應付" : "應收"}</span><span>${total != null ? money(total, ccy) : "—"}</span></div>
    <div class="muted"><span>${side === "buy" ? "可用現金" : "可賣股數"}</span><span>${side === "buy" ? money(availCash(ccy), ccy) : shares(availQty(k)) + " 股"}</span></div>`;
  const btn = $("#oGo");
  btn.disabled = !(c && qty > 0);
  btn.textContent = `${side === "buy" ? "買進" : "賣出"} ${qty > 0 ? shares(qty) + " 股" : ""}${type === "limit" && !manual ? "（限價）" : ""}`;
}
function maxBuy(k, price) {
  const ccy = ccyOf(k), cash = availCash(ccy);
  if (!(price > 0)) return 0;
  let n = Math.floor(cash / price);
  while (n > 0) { const c = costs(k, "buy", n, price); if (c.amount + c.fee <= cash) break; n--; }
  return n;
}
function renderDetail(full) {
  if (!detail) return;
  const { k } = detail, q = Q[k], sh = $("#sheet");
  const chg = q?.last != null && q?.prev ? q.last - q.prev : null;
  const watched = S.watch.includes(k), p = S.pos[k];
  const head = `<div class="sh-head"><div class="t">
      <h3>${esc(nameOf(k))} <small class="muted">${esc(code(k))} · ${mkt(k) === "US" ? "美股" : META[code(k)]?.ex === "otc" ? "上櫃" : "上市"}</small></h3>
      <div class="p ${cls(chg)}">${fmtPx(k, q?.last)} <small style="font-size:15px">${chg == null ? "" : signed(chg, a => fmtPx(k, a)) + "（" + pct(chg / q.prev) + "）"}</small></div>
      <small class="muted">${q ? `${fmtTime(q.time)} · ${q.src === "TWSE" ? "證交所" : "Yahoo"}${isOpen(mkt(k)) ? "" : " · 休市"}` : net.ok === false ? "沒有報價連線" : "載入中…"}</small>
    </div>
    <button type="button" class="icon-btn" id="dWatch" title="${watched ? "移出自選" : "加入自選"}" aria-pressed="${watched}" style="color:${watched ? "#c9822b" : "inherit"}">${ICON.star(watched)}</button>
    <button type="button" class="icon-btn" id="dClose" title="關閉">${ICON.close}</button></div>`;
  const stats = `<div class="stats">
      <div><small>開盤</small><span>${fmtPx(k, q?.open)}</span></div><div><small>最高</small><span>${fmtPx(k, q?.high)}</span></div>
      <div><small>最低</small><span>${fmtPx(k, q?.low)}</span></div><div><small>昨收</small><span>${fmtPx(k, q?.prev)}</span></div>
      <div><small>成交量</small><span>${q?.vol != null ? nf(0, 0).format(q.vol) + " " + (q.unit || "") : "—"}</span></div>
      ${q?.up ? `<div><small>漲停</small><span class="up">${fmtPx(k, q.up)}</span></div><div><small>跌停</small><span class="down">${fmtPx(k, q.dn)}</span></div>` : ""}
    </div>`;
  const mine = p ? (() => { const last = q?.last ?? p.cost / p.qty, mv = last * p.qty, pnl = mv - p.cost; return `<div class="kv">
      <div><small>持有</small><b>${shares(p.qty)} 股</b></div><div><small>平均成本</small><b>${fmtPx(k, p.cost / p.qty)}</b></div>
      <div><small>市值</small><b>${money(mv, ccyOf(k))}</b></div><div><small>未實現損益</small><b class="${cls(pnl)}">${sMoney(pnl, ccyOf(k))}（${pct(pnl / p.cost)}）</b></div></div>`; })() : "";

  const manualNow = q?.last == null;
  if (!full && $("#oForm") && detail.manual !== manualNow && !$("#oForm").contains(document.activeElement)) full = true;
  detail.manual = manualNow;
  if (!full && $("#oForm")) {
    // 只更新會變動的部分，避免打字中的欄位被重畫
    sh.querySelector(".sh-head").outerHTML = head;
    $("#dStats").innerHTML = stats; $("#dMine").innerHTML = mine;
    if (detail.type === "market" || q?.last == null) { /* 估算用現價 */ }
    if ($("#oManual")) $("#oManual").hidden = q?.last != null;
    orderEstimate();
    return;
  }
  const isTW = mkt(k) === "TW";
  const manual = q?.last == null;
  sh.innerHTML = `<div class="grab"></div>${head}
    <div class="sh-body">
      <div style="display:grid;gap:12px;min-width:0">
        <span class="seg" id="dRange">${RANGES.map(([r, , n]) => `<button type="button" data-range="${r}" aria-pressed="${detail.range === r}">${n}</button>`).join("")}</span>
        <div class="chart" id="dChart"><div class="msg">載入走勢圖…</div></div>
        <div id="dStats">${stats}</div>
        <div id="dMine">${mine}</div>
      </div>
      <form class="order card" id="oForm" autocomplete="off">
        <div class="side"><button type="button" data-side="buy" aria-pressed="${detail.side === "buy"}">買進</button><button type="button" data-side="sell" aria-pressed="${detail.side === "sell"}">賣出</button></div>
        <div class="flex"><span class="seg" id="oType"><button type="button" data-type="market" aria-pressed="${detail.type === "market"}">市價</button><button type="button" data-type="limit" aria-pressed="${detail.type === "limit"}">限價</button></span></div>
        <p class="note" id="oManual" ${manual ? "" : "hidden"}>目前抓不到這檔的報價，可以自己輸入成交價來練習。</p>
        <label class="field" id="oPxF" ${detail.type === "limit" || manual ? "" : "hidden"}><span>${manual ? "成交價" : "限價"}（${isTW ? "元" : "美元"}）</span><input id="oPx" type="number" inputmode="decimal" min="0" step="any" value="${q?.last ?? ""}"></label>
        <label class="field"><span>數量（股）${isTW ? "・1 張 = 1,000 股，不滿 1 張是零股" : ""}</span><input id="oQty" type="number" inputmode="numeric" min="0" step="1" value="${isTW ? 1000 : 10}"></label>
        <div class="qtybtns">${isTW ? `<button type="button" data-q="1000">1 張</button><button type="button" data-q="5000">5 張</button><button type="button" data-q="100">100 股</button>` : `<button type="button" data-q="1">1 股</button><button type="button" data-q="10">10 股</button><button type="button" data-q="100">100 股</button>`}<button type="button" data-q="max">最大</button></div>
        <div class="est" id="oEst"></div>
        <div class="warn" id="oWarn"></div>
        <button type="submit" class="btn ${detail.side}" id="oGo">買進</button>
        <p class="note">${isOpen(mkt(k)) ? "市價單以目前價格立即成交。" : "現在休市：市價單會用最後成交價模擬成交；限價單會等開盤後價格到了才成交。"}</p>
      </form>
    </div>`;
  orderEstimate();
  drawDetailChart();
}

/* ---------- 事件 ---------- */
document.addEventListener("click", e => {
  const t = e.target.closest("button, tr.click, [data-open]");
  if (!t) { if (!e.target.closest(".search")) $("#sugg") && ($("#sugg").hidden = true); return; }
  if (t.dataset.tab) return setView(t.dataset.tab);
  if (t.dataset.open) { $("#sugg") && ($("#sugg").hidden = true); if ($("#q")) $("#q").value = ""; return openDetail(t.dataset.open); }
  if (t.dataset.wf) { wFilter = t.dataset.wf; LS.set("ss.wf", wFilter); return renderMarket(); }
  if (t.dataset.hf) { LS.set("ss.hf", t.dataset.hf); return renderHist(); }
  if (t.dataset.cancel) { S.orders = S.orders.filter(o => o.id !== t.dataset.cancel); save(); toast("已取消掛單"); return render(); }
  if (t.id === "acct") return setView("set");
  if (t.id === "dClose") return closeDetail();
  if (t.id === "dWatch") {
    const k = detail.k;
    if (S.watch.includes(k)) { S.watch = S.watch.filter(x => x !== k); toast("已移出自選股"); }
    else { S.watch.push(k); toast("已加入自選股"); }
    save(); render(); return;
  }
  if (t.dataset.range) { detail.range = t.dataset.range; $("#dRange").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.range === detail.range)); drawDetailChart(); loadChart(); return; }
  if (t.dataset.side) { detail.side = t.dataset.side; renderDetail(true); return; }
  if (t.dataset.type) {
    detail.type = t.dataset.type;
    $("#oType").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.type === detail.type));
    $("#oPxF").hidden = detail.type !== "limit" && Q[detail.k]?.last != null;
    if (detail.type === "limit" && !$("#oPx").value && Q[detail.k]?.last) $("#oPx").value = Q[detail.k].last;
    return orderEstimate();
  }
  if (t.dataset.q) {
    const k = detail.k, q = Q[k];
    let n;
    if (t.dataset.q === "max") {
      if (detail.side === "sell") n = availQty(k);
      else { const px = detail.type === "market" && q?.last ? q.last : +$("#oPx").value; n = maxBuy(k, px); }
    } else n = +t.dataset.q;
    $("#oQty").value = n; return orderEstimate();
  }
  if (t.id === "csv") return exportCsv();
  if (t.id === "signIn") return sync ? sync.signIn() : startSync(true);
  if (t.id === "signOut") return sync && sync.signOut();
  if (t.id === "saveCfg") {
    S.cfg = { disc: +$("#cDisc").value || 1, minFee: Math.max(0, +$("#cMin").value || 0), usFee: Math.max(0, +$("#cUs").value || 0) };
    save(); toast("已儲存交易成本"); return;
  }
  if (t.id === "reset") {
    if (t.dataset.confirm !== "1") { t.dataset.confirm = "1"; t.textContent = "再按一次確認重設"; setTimeout(() => { t.dataset.confirm = ""; t.textContent = "重設帳戶"; }, 4000); return; }
    const a = Math.max(0, +$("#rTWD").value || 0), b = Math.max(0, +$("#rUSD").value || 0);
    S = freshState(a, b, S); save(); toast("帳戶已重設"); document.activeElement.blur(); renderSet(); return;
  }
  if (t.id === "saveProxy") { LS.set("ss.proxy", $("#proxy").value.trim()); document.activeElement.blur(); toast("已儲存，重新抓取報價"); refresh(); return; }
});
$("#sheetBg").addEventListener("click", closeDetail);
document.addEventListener("keydown", e => { if (e.key === "Escape" && detail) closeDetail(); });
document.addEventListener("input", e => {
  if (e.target.id === "q") renderSugg();
  if (e.target.id === "oQty" || e.target.id === "oPx") orderEstimate();
});
document.addEventListener("keydown", e => {
  if (e.target.id === "q" && e.key === "Enter") { const k = suggest(e.target.value)[0]; if (k) { e.target.value = ""; $("#sugg").hidden = true; e.target.blur(); openDetail(k); } }
});
document.addEventListener("focusin", e => { if (e.target.id === "q" && e.target.value) renderSugg(); });
document.addEventListener("submit", e => {
  if (e.target.id !== "oForm") return;
  e.preventDefault();
  const k = detail.k, q = Q[k], manual = q?.last == null;
  const r = placeOrder({ k, side: detail.side, qty: +$("#oQty").value, type: manual ? "limit" : detail.type, limit: +$("#oPx").value, manual });
  if (r.err) { $("#oWarn").textContent = r.err; return; }
  $("#oWarn").textContent = "";
  if (r.t) toast(`已成交：${r.t.side === "buy" ? "買進" : "賣出"} ${r.t.name} ${shares(r.t.qty)} 股 @ ${fmtPx(k, r.t.price)}`);
  else toast(`已掛單：${detail.side === "buy" ? "買進" : "賣出"} ${shares(r.order.qty)} 股 @ ${fmtPx(k, r.order.limit)}，價格到了會自動成交`);
  render(); renderDetail(true);
});
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (view === "port") renderPort(); drawDetailChart(); }, 150); });

function exportCsv() {
  const head = ["時間", "市場", "代號", "名稱", "買賣", "股數", "價格", "成交金額", "手續費", "交易稅", "幣別", "已實現損益", "方式"];
  const rows = S.trades.map(t => [fmtDate(t.t), mkt(t.k), code(t.k), t.name, t.side === "buy" ? "買進" : "賣出", t.qty, t.price, t.amount, t.fee, t.tax || 0, t.ccy, t.pnl ?? "", t.how]);
  const csv = "﻿" + [head, ...rows].map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `股市模擬交易紀錄-${twNow().date}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- 雲端同步 ---------- */
async function startSync(interactive) {
  try {
    const m = await import("./sync.js");
    sync = m.createSync({
      getState: () => S,
      onRemote: remote => {
        if (!remote || !remote.v) return;
        if ((remote.updated || 0) <= (S.updated || 0)) return; // 本機比較新（或一樣），不要被舊的蓋掉
        S = remote; LS.set("ss.state", S); render();
      },
      onStatus: info => { syncInfo = info; render(); },
    });
    if (interactive) sync.signIn();
  } catch (e) {
    syncInfo = { state: "error", err: "無法載入同步功能：" + (e?.message || e) };
    render();
  }
}

/* ---------- 開始 ---------- */
if (!TABS.some(t => t[0] === view)) view = "market";
for (const [id] of TABS) $("#v-" + id).hidden = id !== view;
render();
refresh();
startSync(false);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
