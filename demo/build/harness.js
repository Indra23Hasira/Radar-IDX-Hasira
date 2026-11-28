// Membangun demo/demo-data.json dengan menjalankan index.html ASLI (upload → Tahap 4 → Tahap 5)
// di Chromium headless, memakai fake-firebase.js dan pasar fiktif dari gen-market.js.
'use strict';
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const XLSX = require('xlsx');
const M = require('./gen-market');

const REPO = path.resolve(__dirname, '../..');
const HERE = __dirname;
const BASE = 'http://127.0.0.1:8765';
const STEP5_LAST = parseInt(process.env.STEP5_LAST || '30', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10);

(async () => {
  const mk = M.build();
  const days = [];
  for(let i = mk.uploadFrom; i < mk.dates.length; i++) days.push(i);
  const run = LIMIT ? days.slice(0, LIMIT) : days;
  fs.mkdirSync(path.join(HERE, '.xlsx'), { recursive: true });
  const fakeFb = fs.readFileSync(path.join(REPO, 'demo/fake-firebase.js'), 'utf8');
  const xlsxLib = fs.readFileSync(require.resolve('xlsx/dist/xlsx.full.min.js'), 'utf8');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  let curIdx = run[0];
  const external = new Set();
  await page.route('**/*', async route => {
    const url = route.request().url();
    if(url.startsWith(BASE)) return route.continue();
    if(url.includes('gstatic.com/firebasejs')) return route.fulfill({ contentType: 'application/javascript', body: fakeFb });
    if(url.includes('cdnjs.cloudflare.com/ajax/libs/xlsx')) return route.fulfill({ contentType: 'application/javascript', body: xlsxLib });
    if(url.includes('workers.dev') || url.includes('allorigins') || url.includes('corsproxy') || url.includes('codetabs') || url.includes('jina.ai')){
      const target = decodeURIComponent((url.split('url=')[1] || '').split('&')[0]);
      const m = target.match(/chart\/([A-Z0-9]+)\.JK/);
      if(m && url.includes('workers.dev')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(M.yahooChart(mk, m[1], curIdx)) });
      return route.fulfill({ status: 503, body: 'x' });
    }
    external.add(new URL(url).host);
    return route.abort();
  });
  page.on('dialog', d => d.accept());
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if(m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.goto(BASE + '/index.html');
  await page.waitForFunction(() => document.getElementById('loginOverlay').style.display === 'none', null, { timeout: 20000 });

  const t0 = Date.now();
  for(const idx of run){
    curIdx = idx;
    const date = mk.dates[idx];
    const file = path.join(HERE, 'xlsx', `RS-${date}.xlsx`);
    if(!fs.existsSync(file)){
      const ws = XLSX.utils.json_to_sheet(M.excelRows(mk, idx));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      XLSX.writeFile(wb, file);
    }
    await page.evaluate(() => { document.getElementById('stepNum4').classList.remove('done'); document.getElementById('stepNum5').classList.remove('done'); });
    await page.setInputFiles('#fileInput', file);
    await page.waitForFunction(() => !document.getElementById('btnSave').disabled, null, { timeout: 20000 }).catch(async () => {
      const v = await page.evaluate(() => document.getElementById('validationOutput').innerText + ' | ' + document.getElementById('overwriteWrap').innerText);
      throw new Error('btnSave tidak aktif untuk ' + date + ': ' + v.slice(0, 400));
    });
    await page.click('#btnSave');
    await page.waitForFunction(() => document.getElementById('stepNum4').classList.contains('done'), null, { timeout: 180000 }).catch(async () => {
      const v = await page.evaluate(() => document.getElementById('saveResult').innerText);
      throw new Error('Tahap 4 tidak selesai ' + date + ': ' + v.slice(0, 600));
    });
    let s5 = '';
    if(idx >= mk.dates.length - STEP5_LAST){
      await page.click('#btnUpdateIndicators');
      await page.waitForFunction(() => document.getElementById('btnUpdateIndicators').disabled, null, { timeout: 5000 }).catch(() => {});
      await page.waitForFunction(() => !document.getElementById('btnUpdateIndicators').disabled, null, { timeout: 300000 });
      if(!(await page.evaluate(() => document.getElementById('stepNum5').classList.contains('done')))) errs.push('T5 gagal ' + date);
      s5 = ' +T5';
    }
    const n = await page.evaluate(() => globalThis.__FAKE_FIRESTORE__.size);
    console.log(`${date} ok${s5} docs=${n} t=${((Date.now() - t0) / 1000).toFixed(0)}s errs=${errs.length}`);
  }

  // ekspor isi "database"
  const dump = await page.evaluate(async () => {
    const m = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    return m.__dumpStore();
  });
  fs.writeFileSync(path.join(HERE, '.store-full.json'), JSON.stringify(dump));
  const diag = await page.evaluate(() => document.getElementById('saveResult')?.innerText?.slice(0, 1500));
  console.log('LAST saveResult:\n' + diag);
  console.log('external hosts blocked:', [...external]);
  console.log('errors:', errs.slice(0, 20));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
