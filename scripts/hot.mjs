// 山姆百貨 熱門搜尋關鍵字自動更新程式
// ------------------------------------------------------------
// 由 GitHub Actions 每週跑一次（見 .github/workflows/hot.yml），從
// Google Analytics（山姆百貨 - GA4）讀取最近 30 天客人實際搜尋過的字，
// 挑出最熱門的前幾名寫進 hot.json，官網搜尋框下面的「熱門搜尋」會讀它。
//
// 搜尋字從哪來：客人每次搜尋都會開 /search?q=關鍵字 這個網址，GA4 有
// 記下每個網址被看了幾次、幾個人看，這裡把 q= 後面的字取出來統計。
//
// 安全與隱私：
//   ・GA4 金鑰只從 GitHub Secret（環境變數 GA4_KEY）讀，不會印出來。
//   ・專案是公開的，執行紀錄別人也看得到，所以「原始搜尋字」一律不印、
//     不存，只印統計數字和最後上榜的字。
//   ・只有「在官網搜得到商品」的字才能上榜（比對 products.json），客人
//     誤打的電話、Email、訂單編號、錯字都不可能出現。
//   ・依「搜尋過的人數」排名，不是次數，同一個人一直搜也洗不上去。
//   ・hot-blocklist.txt 裡列的字永遠不顯示（一行一個）。

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const PROPERTY = process.env.GA4_PROPERTY || '386380328';
const TOP_N = Number(process.env.HOT_TOP_N || 8);
const MIN_USERS = Number(process.env.HOT_MIN_USERS || 2);   // 至少幾個不同的人搜過才算
const MIN_KEEP = Number(process.env.HOT_MIN_KEEP || 3);     // 上榜的字少於這個數就不覆蓋舊清單
const TOKEN_URL = process.env.GA4_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const API_BASE = process.env.GA4_API_BASE || 'https://analyticsdata.googleapis.com';
const OUT = process.env.HOT_OUT || 'hot.json';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  let sig;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(header + '.' + claim);
    sig = signer.sign(key.private_key);
  } catch {
    throw new Error('GA4_KEY 裡的金鑰讀不出來，請重新貼一次完整的 .json 檔內容。');
  }
  const jwt = header + '.' + claim + '.' + b64url(sig);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  if (!res.ok) throw new Error('取得 Google 授權失敗（HTTP ' + res.status + '）。請確認 GA4_KEY 是完整的 .json 內容。');
  return (await res.json()).access_token;
}

async function fetchSearchPages(token) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`${API_BASE}/v1beta/properties/${PROPERTY}:runReport`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({
        dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
        dimensions: [{ name: 'pagePathPlusQueryString' }],
        metrics: [{ name: 'totalUsers' }, { name: 'screenPageViews' }],
        dimensionFilter: { filter: { fieldName: 'pagePathPlusQueryString', stringFilter: { matchType: 'BEGINS_WITH', value: '/search' } } },
        limit: 10000,
        offset,
      }),
    });
    if (res.status === 403) throw new Error('GA4 拒絕讀取（HTTP 403）。請確認讀取帳號已在 GA4「資源存取管理」加成檢視者，而且 Google Analytics Data API 已啟用。');
    if (!res.ok) throw new Error('讀取 GA4 報表失敗（HTTP ' + res.status + '）');
    const data = await res.json();
    const batch = data.rows || [];
    rows.push(...batch);
    offset += batch.length;
    if (!batch.length || offset >= (data.rowCount || 0)) break;
  }
  return rows;
}

// 跟官網搜尋框 v51 同一套比對方式：不分大小寫、忽略空白和連字號，空白隔開的每段都要出現
function norm(s) { return String(s).toLowerCase().replace(/[\s\-_．.·・]/g, ''); }
function matchesSomeProduct(term, normTitles) {
  const terms = term.trim().split(/\s+/).map(norm).filter(Boolean);
  if (!terms.length) return false;
  return normTitles.some((n) => terms.every((t) => n.includes(t)));
}

function extractQuery(pathPlusQuery) {
  const i = pathPlusQuery.indexOf('?');
  if (i === -1) return '';
  const path = pathPlusQuery.slice(0, i);
  if (path !== '/search' && path !== '/search/') return '';
  let q = '';
  try { q = new URLSearchParams(pathPlusQuery.slice(i + 1)).get('q') || ''; } catch { return ''; }
  return q.replace(/\s+/g, ' ').trim();
}

function looksPrivate(q) {
  if (/@/.test(q)) return true;                       // Email
  if (/^[\d\s\-+()#]+$/.test(q)) return true;         // 純數字：電話、訂單編號
  if (/\d{6,}/.test(q.replace(/[\s\-]/g, ''))) return true; // 長串數字
  return false;
}

async function main() {
  if (!process.env.GA4_KEY) throw new Error('找不到 GA4_KEY，請確認 GitHub Secret 已設定。');
  let key;
  try { key = JSON.parse(process.env.GA4_KEY); } catch { throw new Error('GA4_KEY 不是有效的 .json 內容，請重新貼一次整個檔案。'); }

  const products = JSON.parse(await fs.readFile('products.json', 'utf8'));
  const normTitles = (products.items || []).map(([t]) => norm(t));
  let blocklist = [];
  try {
    blocklist = (await fs.readFile('hot-blocklist.txt', 'utf8')).split(/\r?\n/)
      .map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map(norm);
  } catch { /* 沒有黑名單檔就算了 */ }

  const token = await getAccessToken(key);
  const rows = await fetchSearchPages(token);

  // 同一個字（忽略大小寫、空白、連字號）合併計算；顯示時用最多人打的那種寫法
  const groups = new Map();
  let searchPages = 0;
  for (const r of rows) {
    const q = extractQuery(r.dimensionValues[0].value);
    if (!q) continue;
    searchPages++;
    const users = Number(r.metricValues[0].value) || 0;
    const views = Number(r.metricValues[1].value) || 0;
    const k = norm(q);
    if (!k) continue;
    const g = groups.get(k) || { users: 0, views: 0, forms: new Map() };
    g.users += users;
    g.views += views;
    g.forms.set(q, (g.forms.get(q) || 0) + users);
    groups.set(k, g);
  }

  const ranked = [...groups.entries()]
    .map(([k, g]) => ({ k, users: g.users, views: g.views, label: [...g.forms.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .filter((x) => x.users >= MIN_USERS)
    .filter((x) => x.label.length <= 30)
    .filter((x) => !looksPrivate(x.label))
    .filter((x) => !blocklist.includes(x.k))
    .filter((x) => matchesSomeProduct(x.label, normTitles))
    .sort((a, b) => b.users - a.users || b.views - a.views);

  const top = ranked.slice(0, TOP_N);
  // 只印統計數字和上榜的字，不印其他客人打過的原始搜尋字
  console.log(`GA4 最近 30 天：搜尋結果網址 ${searchPages} 種，合併後 ${groups.size} 個不同的字，符合條件 ${ranked.length} 個。`);
  console.log('本週熱門搜尋：' + (top.length ? top.map((x) => `${x.label}（${x.users} 人）`).join('、') : '（無）'));

  if (top.length < MIN_KEEP) {
    console.log(`符合條件的字少於 ${MIN_KEEP} 個，這次不覆蓋，官網繼續顯示上一次的熱門搜尋。`);
    return;
  }
  await fs.writeFile(OUT, JSON.stringify({ v: 1, updated: new Date().toISOString(), keywords: top.map((x) => x.label) }, null, 2) + '\n');
}

main().catch((e) => {
  console.error('熱門搜尋更新失敗：' + e.message);
  process.exitCode = 1;
});
