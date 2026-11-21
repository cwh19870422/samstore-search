// 山姆百貨 samstore.com.tw 商品清單自動更新程式
// ------------------------------------------------------------
// 由 GitHub Actions 每天跑一次（見 .github/workflows/update.yml），產生
// products.json 給官網搜尋框的「自動完成」使用，讓建議可以在訪客瀏覽器
// 裡直接比對、秒出，不用每打一個字都等官網伺服器。
//
// 做法：
//   1. 讀官網網站地圖 /sitemap.xml，拿到目前所有上架商品的網址代號（handle）
//   2. 新上架的商品：逐一打 /products/{handle}.json 取得商品名稱
//   3. 舊商品：每天輪流重新檢查一部分（最久沒檢查的先），抓到改名
//   4. 網站地圖裡已經沒有的商品（下架）：從清單移除
//
// 慢速：Cyberbiz 每秒請求太多次會回 429 並暫時擋掉，所以每次請求之間
// 至少間隔 SAM_DELAY_MS 毫秒，遇到 429 就等 60 秒再試。
//
// 防呆：網站地圖抓不到、或商品數量突然少了一半以上（多半是官網暫時出
// 問題），這次就不覆蓋舊清單，直接結束，避免把清單洗成空的。

import fs from 'node:fs/promises';

const BASE = process.env.SAM_BASE || 'https://www.samstore.com.tw';
const DELAY_MS = Number(process.env.SAM_DELAY_MS || 700);       // 每次請求間隔
const RECHECK = Number(process.env.SAM_RECHECK || 300);         // 每天重新檢查幾個舊商品
const MAX_MINUTES = Number(process.env.SAM_MAX_MINUTES || 60);  // 單次最多跑幾分鐘，剩下的明天繼續
const RETRY_WAIT_MS = Number(process.env.SAM_RETRY_WAIT_MS || 60000);
const OUT = process.env.SAM_OUT || 'products.json';
const META = process.env.SAM_META || 'meta.json';
const UA = 'samstore-search-updater (+https://github.com/cwh19870422/samstore-search)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const startedAt = Date.now();

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

// 打一次請求；429 就等一下再試，最多 5 次
async function get(path) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(BASE + path, { headers: { 'User-Agent': UA, 'Accept': 'application/json, text/xml, */*' } });
    } catch (e) {
      if (attempt === 5) throw e;
      await sleep(5000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      console.log(`  ${res.status}，等 ${RETRY_WAIT_MS / 1000} 秒再試（第 ${attempt} 次）`);
      if (attempt === 5) return res;
      await sleep(RETRY_WAIT_MS);
      continue;
    }
    return res;
  }
}

function parseHandles(xml) {
  const out = [];
  const seen = new Set();
  const re = /<loc>\s*https?:\/\/[^<]*?\/products\/([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml))) {
    let h = m[1];
    try { h = decodeURIComponent(h); } catch { /* 保留原字串 */ }
    if (!seen.has(h)) { seen.add(h); out.push(h); }
  }
  return out;
}

async function main() {
  const prev = await readJson(OUT, { items: [] });
  const meta = await readJson(META, { checked: {} });
  const prevMap = new Map((prev.items || []).map(([t, h]) => [h, t]));
  const checked = meta.checked || {};

  // 1. 網站地圖
  const smRes = await get('/sitemap.xml');
  if (!smRes || !smRes.ok) {
    console.log(`網站地圖抓不到（${smRes && smRes.status}），這次不更新。`);
    process.exitCode = 1;
    return;
  }
  const handles = parseHandles(await smRes.text());
  console.log(`網站地圖：${handles.length} 個商品；舊清單：${prevMap.size} 個`);
  if (handles.length < 50 || (prevMap.size > 0 && handles.length < prevMap.size * 0.5)) {
    console.log('商品數量異常偏少，可能是官網暫時出問題，這次不覆蓋清單。');
    process.exitCode = 1;
    return;
  }

  // 2. 決定這次要抓哪些：新商品全部 + 最久沒檢查的舊商品 RECHECK 個
  const fresh = handles.filter((h) => !prevMap.has(h));
  const old = handles
    .filter((h) => prevMap.has(h))
    .sort((a, b) => String(checked[a] || '').localeCompare(String(checked[b] || '')))
    .slice(0, RECHECK);
  const todo = [...fresh, ...old];
  console.log(`這次要抓：新商品 ${fresh.length} 個、重新檢查 ${old.length} 個`);

  // 3. 逐一抓商品名稱
  const titles = new Map(prevMap);
  const gone = new Set();
  let done = 0, renamed = 0, failed = 0, stoppedEarly = false;
  for (const h of todo) {
    if (Date.now() - startedAt > MAX_MINUTES * 60000) { stoppedEarly = true; break; }
    const res = await get('/products/' + encodeURIComponent(h) + '.json');
    if (res && res.ok) {
      try {
        const j = await res.json();
        const t = String(j.title || '').trim();
        if (t) {
          if (prevMap.has(h) && prevMap.get(h) !== t) renamed++;
          titles.set(h, t);
          checked[h] = today;
        }
      } catch { failed++; }
    } else if (res && res.status === 404) {
      gone.add(h);
    } else {
      failed++;
    }
    done++;
    if (done % 100 === 0) console.log(`  已抓 ${done}/${todo.length}`);
    await sleep(DELAY_MS);
  }

  // 4. 依網站地圖順序組成新清單（地圖裡沒有的＝下架，自然被移除）
  const items = [];
  const inMap = new Set(handles);
  for (const h of handles) {
    if (gone.has(h)) continue;
    const t = titles.get(h);
    if (t) items.push([t, h]);
  }
  for (const h of Object.keys(checked)) if (!inMap.has(h) || gone.has(h)) delete checked[h];

  const removed = [...prevMap.keys()].filter((h) => !inMap.has(h) || gone.has(h)).length;
  console.log(`完成：清單 ${items.length} 個（新增 ${items.filter(([, h]) => !prevMap.has(h)).length}、改名 ${renamed}、下架 ${removed}、失敗 ${failed}）` +
    (stoppedEarly ? `；時間到先停，剩下 ${todo.length - done} 個明天繼續` : ''));

  if (items.length < 50) {
    console.log('清單太少，不覆蓋。');
    process.exitCode = 1;
    return;
  }

  const out = {
    v: 1,
    updated: new Date().toISOString(),
    count: items.length,
    items,
  };
  // 一個商品一行，檔案在 GitHub 上比較好看出每天改了什麼
  const body = '{"v":1,"updated":' + JSON.stringify(out.updated) + ',"count":' + out.count + ',"items":[\n' +
    items.map((it) => JSON.stringify(it)).join(',\n') + '\n]}\n';
  await fs.writeFile(OUT, body);
  await fs.writeFile(META, JSON.stringify({ checked }, null, 0) + '\n');
}

main().catch((e) => {
  console.error('更新失敗：', e);
  process.exitCode = 1;
});
