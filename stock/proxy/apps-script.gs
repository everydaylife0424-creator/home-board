/* 股市模擬的報價轉接站（Google Apps Script）
   網頁不能直接向證交所或 Yahoo 抓資料（對方沒有開放跨網站存取），所以由這支小程式代抓。
   只會轉接下面 ALLOW 清單裡的網站，不能被拿去抓別的東西。

   用法：GET <部署網址>?u=<JSON 陣列，裡面是要抓的網址>
   回傳：[{ s: HTTP 狀態碼, b: 內容文字 }, ...]，順序和傳入的網址相同。 */

var ALLOW = [
  "mis.twse.com.tw",
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "openapi.twse.com.tw",
  "www.tpex.org.tw",
  "www.twse.com.tw"
];

function doGet(e) {
  var urls = [];
  try { urls = JSON.parse((e && e.parameter && e.parameter.u) || "[]"); } catch (x) {}
  if (!Array.isArray(urls)) urls = [];
  urls = urls.slice(0, 40);

  var out = urls.map(function () { return { s: 0, b: "" }; });
  var reqs = [], idx = [];
  urls.forEach(function (u, i) {
    var m = /^https:\/\/([^\/?#:]+)[\/?#]/.exec(String(u) + "/");
    if (m && ALLOW.indexOf(m[1]) >= 0) {
      reqs.push({
        url: u, muteHttpExceptions: true, followRedirects: true,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/json,text/plain,*/*" }
      });
      idx.push(i);
    } else {
      out[i] = { s: 403, b: "host not allowed" };
    }
  });

  if (reqs.length) {
    var rs = null;
    try { rs = UrlFetchApp.fetchAll(reqs); } catch (x) { rs = null; }
    reqs.forEach(function (r, k) {
      var res = rs && rs[k];
      if (!res) { try { res = UrlFetchApp.fetch(r.url, r); } catch (x) { out[idx[k]] = { s: 0, b: String(x) }; return; } }
      out[idx[k]] = { s: res.getResponseCode(), b: res.getContentText() };
    });
  }

  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
