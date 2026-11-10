// radar-bundle.js — "arsip hemat" Firestore untuk aplikasi Radar (project radar-idx-hasira)
// v1 · 9 Nov 2026
//
// Masalah: kuota gratis Firestore (Spark) dihitung PER DOKUMEN yang dibaca (±50.000/hari, dipakai
// bersama Radar IDX, Dashboard, Konglo, Pengendali, Radar-DayTrade). Membaca histori 20 hari untuk
// 800 saham = 16.000 dokumen sekali klik.
// Solusi: data yang sama disimpan juga sebagai "bundle" — satu dokumen berisi seluruh saham satu
// tanggal (dikompres gzip). Membaca 20 hari histori = 20 dokumen, dan yang sudah pernah dibaca
// disimpan di browser (IndexedDB) sehingga berikutnya 0 baca.
//
// Koleksi lama (dailySummary, tickerHistory, tickerRollingStats, tickerIndicators, ownership) TETAP
// ditulis seperti biasa. Bundle hanya salinan untuk dibaca; kalau bundle tidak ada / tidak cocok,
// pemanggil jatuh balik ke cara lama, jadi hasil tidak berubah.
//
// Koleksi `radarBundles`:
//   meta              { v, known:{tanggal:true}, days:{tanggal:{s,n}}, rolling:{s,n,maxUpd,techAt},
//                       indicators:{s,n,techAt}, ownership:{s,n,maxUpd}, build:{day,n} }
//   day_<tanggal>     semua baris dailySummary/<tanggal>/stocks (urut ticker)
//   rolling           salinan tickerRollingStats   [[id, data], ...]
//   indicators        salinan tickerIndicators     [[id, data], ...]
//   ownership         ringkas ownership untuk Konglo [[ticker, {top_holder_group_id, top_holder_group_name}], ...]
//   <nama>__p<i>      potongan lanjutan kalau satu bundle > ±900 KB

const COL = 'radarBundles';
const VERSION = 1;
const PART_GZ = 900000;   // karakter base64 (ASCII) per dokumen — batas Firestore 1 MiB
const PART_JSON = 300000; // tanpa kompresi (browser lama): aman untuk karakter multi-byte
export const DAILY_BUILD_LIMIT = 30; // maks bundle tanggal lama yang dibangun per hari kuota (±28.500 baca)

// Kuota gratis Firestore reset tengah malam waktu Pasifik (14:00 WIB saat musim panas AS, 15:00 WIB Nov–Mar).
export function quotaDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const stampNew = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const tsMillis = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : null);

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

// ---------------------------------------------------------------- cache browser (IndexedDB)
// Satu database untuk semua halaman di indra23hasira.github.io, jadi Konglo ikut memakai tanggal
// yang sudah dibaca Radar IDX. Isi selalu dicocokkan dengan stempel di radarBundles/meta.
let idbP = null;
function idb() {
  if (idbP) return idbP;
  idbP = new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') return res(null);
      const r = indexedDB.open('radar-bundle-cache', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('b');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
  return idbP;
}
function idbReq(mode, fn) {
  return idb().then((d) => new Promise((res) => {
    if (!d) return res(null);
    try {
      const st = d.transaction('b', mode).objectStore('b');
      const r = fn(st);
      r.onsuccess = () => res(r.result === undefined ? null : r.result);
      r.onerror = () => res(null);
    } catch (e) { res(null); }
  }));
}
const cacheGet = (k) => idbReq('readonly', (st) => st.get(k));
const cachePut = (k, v) => idbReq('readwrite', (st) => st.put(v, k));
const cacheDel = (k) => idbReq('readwrite', (st) => st.delete(k));
const cacheKeys = () => idbReq('readonly', (st) => st.getAllKeys());
async function cachePrune(keep = 140) {
  const keys = ((await cacheKeys()) || []).filter((k) => String(k).startsWith('day_')).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - keep))) await cacheDel(k);
}

// ---------------------------------------------------------------- encode / decode
// NaN/Infinity dan Timestamp Firestore disimpan dengan penanda supaya kembali persis.
function plainify(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : { __n: String(v) };
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function') return { __ts: v.toMillis() };
  if (Array.isArray(v)) return v.map(plainify);
  const o = {};
  for (const k of Object.keys(v)) { if (v[k] !== undefined) o[k] = plainify(v[k]); }
  return o;
}
function reviverFor(fs) {
  return (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ks = Object.keys(v);
      if (ks.length === 1 && ks[0] === '__n') return Number(v.__n);
      if (ks.length === 1 && ks[0] === '__ts') return fs && fs.Timestamp ? fs.Timestamp.fromMillis(v.__ts) : v.__ts;
    }
    return v;
  };
}
function b64enc(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64dec(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const canGzip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
async function encode(obj) {
  const json = JSON.stringify(plainify(obj));
  if (canGzip()) {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    return { enc: 'gz64', str: b64enc(new Uint8Array(await new Response(stream).arrayBuffer())) };
  }
  return { enc: 'json', str: json };
}
async function decode(enc, str, fs) {
  let json;
  if (enc === 'json') json = str;
  else if (enc === 'gz64') {
    if (!canGzip()) throw new Error('browser tidak mendukung DecompressionStream');
    const stream = new Blob([b64dec(str)]).stream().pipeThrough(new DecompressionStream('gzip'));
    json = await new Response(stream).text();
  } else throw new Error('format bundle tidak dikenal: ' + enc);
  return JSON.parse(json, reviverFor(fs));
}

function deepMerge(a, b) {
  for (const k of Object.keys(b)) {
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.toMillis !== 'function') {
      a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v);
    } else a[k] = v;
  }
  return a;
}
const clone = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));

export class BudgetError extends Error {
  constructor(missing, remaining) {
    super(`Arsip hemat: ${missing} tanggal belum diarsipkan, jatah bangun hari ini tinggal ${remaining}.`);
    this.code = 'budget'; this.missing = missing; this.remaining = remaining;
  }
}

// ---------------------------------------------------------------- API
// fs  = modul firebase-firestore (doc, getDoc, getDocs, setDoc, collection, query, orderBy, limit,
//       writeBatch, deleteField, getCountFromServer, Timestamp)
// canWrite = false untuk halaman tanpa login (Konglo): hanya membaca bundle yang sudah ada.
export function createRadarBundles({ db, fs, canWrite = true, log = () => {} }) {
  const S = { meta: null, metaAt: 0, mem: new Map(), td: null, reads: 0, writes: 0, built: 0, cacheHits: 0 };
  const ref = (id) => fs.doc(db, COL, id);
  const addReads = (snap) => { S.reads += Math.max(1, snap && typeof snap.size === 'number' ? snap.size : 1); return snap; };

  async function meta(fresh = false) {
    if (!fresh && S.meta && Date.now() - S.metaAt < 60e3) return S.meta;
    const s = await fs.getDoc(ref('meta')); S.reads++;
    S.meta = s.exists() ? s.data() : {};
    S.metaAt = Date.now();
    return S.meta;
  }

  async function getBundle(name, s, retried = false) {
    const m = S.mem.get(name);
    if (m && m.s === s) { S.cacheHits++; return m.data; }
    const c = await cacheGet(name);
    if (c && c.s === s && c.v === VERSION) { S.cacheHits++; S.mem.set(name, c); return c.data; }
    const snap = await fs.getDoc(ref(name)); S.reads++;
    const d = snap.exists() ? snap.data() : null;
    if (!d || d.s !== s) {
      if (retried) return null;
      // meta di memori sudah usang (ada penulisan baru) — baca ulang meta sekali
      const fm = await meta(true);
      const ns = name.startsWith('day_') ? fm.days && fm.days[name.slice(4)] && fm.days[name.slice(4)].s : fm[name] && fm[name].s;
      return ns ? getBundle(name, ns, true) : null;
    }
    const strs = [d.p0 || ''];
    if ((d.parts || 1) > 1) {
      const rest = await Promise.all(Array.from({ length: d.parts - 1 }, (_, i) => fs.getDoc(ref(`${name}__p${i + 1}`))));
      S.reads += rest.length;
      for (const ps of rest) { if (!ps.exists() || ps.data().s !== s) return null; strs.push(ps.data().p); }
    }
    const data = await decode(d.enc, strs.join(''), fs);
    const entry = { v: VERSION, s, data };
    S.mem.set(name, entry);
    cachePut(name, entry).then(() => (name.startsWith('day_') ? cachePrune() : null));
    return data;
  }

  // Tulis bundle + pembaruan meta dalam SATU batch (atomik). extra(batch, stamp) untuk tulisan lain.
  async function putBundle(name, payload, metaPatch, extra) {
    if (!canWrite) throw new Error('mode hanya-baca');
    const { enc, str } = await encode(payload);
    const size = enc === 'gz64' ? PART_GZ : PART_JSON;
    const parts = [];
    for (let i = 0; i < str.length; i += size) parts.push(str.slice(i, i + size));
    if (!parts.length) parts.push('');
    if (parts.length > 40) throw new Error(`bundle ${name} terlalu besar (${parts.length} potongan)`);
    const s = stampNew();
    const batch = fs.writeBatch(db);
    parts.slice(1).forEach((p, i) => batch.set(ref(`${name}__p${i + 1}`), { s, p }));
    batch.set(ref(name), { v: VERSION, s, enc, parts: parts.length, p0: parts[0], at: new Date().toISOString() });
    const mp = { v: VERSION, ...metaPatch(s) };
    batch.set(ref('meta'), mp, { merge: true });
    if (extra) extra(batch, s);
    await batch.commit();
    S.writes += parts.length + 1 + (extra ? 1 : 0);
    if (S.meta) deepMerge(S.meta, mp);
    const entry = { v: VERSION, s, data: payload };
    S.mem.set(name, entry);
    await cachePut(name, entry);
    if (name.startsWith('day_')) cachePrune();
    return s;
  }

  function budgetLeft() {
    const m = S.meta || {};
    const used = m.build && m.build.day === quotaDay() ? m.build.n || 0 : 0;
    return Math.max(0, DAILY_BUILD_LIMIT - used);
  }
  function budgetUse(n) {
    const m = S.meta || (S.meta = {});
    const today = quotaDay();
    const used = m.build && m.build.day === today ? m.build.n || 0 : 0;
    m.build = { day: today, n: used + n };
    if (canWrite) fs.setDoc(ref('meta'), { build: m.build }, { merge: true }).then(() => { S.writes++; }, () => {});
  }

  // Daftar tanggal bursa (= id dokumen dailySummary) + dokumen meta tanggal terbaru.
  // 3 baca (meta, tanggal terbaru, hitungan) — dulu membaca SEMUA dokumen dailySummary.
  async function tradingDates({ verify = true } = {}) {
    const m = await meta(true);
    const lq = addReads(await fs.getDocs(fs.query(fs.collection(db, 'dailySummary'), fs.orderBy('tradingDate', 'desc'), fs.limit(1))));
    const latest = lq.empty ? null : { id: lq.docs[0].id, data: lq.docs[0].data() };
    let known = m.known ? Object.keys(m.known) : null;
    let ok = !!known && (!latest || !!m.known[latest.id]);
    if (ok && verify && typeof fs.getCountFromServer === 'function') {
      try {
        const c = await fs.getCountFromServer(fs.collection(db, 'dailySummary')); S.reads++;
        if (c.data().count !== known.length) ok = false;
      } catch (e) { log('Hitung dailySummary gagal (diabaikan): ' + e.message); }
    }
    if (!ok) {
      const all = addReads(await fs.getDocs(fs.collection(db, 'dailySummary')));
      known = all.docs.map((d) => d.id);
      const map = {}; known.forEach((k) => { map[k] = true; });
      m.known = map;
      if (canWrite) {
        try { await fs.setDoc(ref('meta'), { v: VERSION, known: map }, { mergeFields: ['v', 'known'] }); S.writes++; }
        catch (e) { log('Meta arsip gagal ditulis: ' + e.message); }
      }
    }
    known.sort(cmpId);
    S.td = { dates: known, latest, at: Date.now() };
    return S.td;
  }

  // Tanggal terbaru tanpa daftar lengkap (1 baca) — untuk halaman yang hanya butuh hari terakhir.
  async function latestDay() {
    const lq = addReads(await fs.getDocs(fs.query(fs.collection(db, 'dailySummary'), fs.orderBy('tradingDate', 'desc'), fs.limit(1))));
    const latest = lq.empty ? null : { id: lq.docs[0].id, data: lq.docs[0].data() };
    S.td = { dates: S.td ? S.td.dates : null, latest, at: S.td ? S.td.at : 0 };
    return latest;
  }

  // Pakai dokumen meta tanggal terbaru yang sudah dibaca pemanggil (mis. Konglo: orderBy(documentId())).
  function useLatest(latest) { S.td = { dates: S.td ? S.td.dates : null, latest, at: S.td ? S.td.at : 0 }; }

  function dayEntryValid(m, date) {
    const e = m.days && m.days[date];
    if (!e) return null;
    // tanggal terbaru: stempel harus sama dengan yang tercatat di dokumen dailySummary (upload dari
    // versi lama aplikasi tidak menulis bundleStamp → arsip dianggap usang dan dibangun ulang)
    const lat = S.td && S.td.latest && S.td.latest.id === date ? S.td.latest : null;
    if (lat && (lat.data.bundleStamp || null) !== e.s) return null;
    return e;
  }

  async function putDay(date, rows, { dailyMeta } = {}) {
    const byT = new Map();
    rows.forEach((r) => byT.set(r.ticker, r)); // id dokumen = ticker; duplikat → yang terakhir (sama seperti Firestore)
    const list = [...byT.values()].sort((a, b) => cmpId(a.ticker, b.ticker));
    const s = await putBundle('day_' + date, list,
      (st) => ({ days: { [date]: { s: st, n: list.length } }, known: { [date]: true } }),
      (batch, st) => {
        const dref = fs.doc(db, 'dailySummary', date);
        if (dailyMeta) batch.set(dref, { ...dailyMeta, bundleStamp: st });
        else batch.set(dref, { bundleStamp: st }, { merge: true });
      });
    if (S.td && S.td.latest && S.td.latest.id === date) S.td.latest.data = { ...S.td.latest.data, ...(dailyMeta || {}), bundleStamp: s };
    if (S.td && S.td.dates && !S.td.dates.includes(date)) { S.td.dates.push(date); S.td.dates.sort(cmpId); }
    return s;
  }

  async function buildDay(date) {
    const snap = addReads(await fs.getDocs(fs.collection(db, 'dailySummary', date, 'stocks')));
    const rows = snap.docs.map((d) => d.data());
    S.built++;
    if (canWrite && rows.length) {
      try { await putDay(date, rows); }
      catch (e) { log(`Arsip ${date} gagal ditulis: ${e.message}`); }
    }
    return rows.sort((a, b) => cmpId(a.ticker, b.ticker));
  }

  // Semua baris saham satu tanggal (salinan baru tiap panggilan). build=false → null kalau belum ada arsip.
  async function day(date, { build = true, force = false } = {}) {
    const m = await meta();
    const e = dayEntryValid(m, date);
    let rows = e ? await getBundle('day_' + date, e.s) : null;
    if (!rows) {
      if (!build || !canWrite) return null;
      const stale = !!(m.days && m.days[date]);
      if (!force && !stale) { if (budgetLeft() < 1) throw new BudgetError(1, 0); budgetUse(1); }
      rows = await buildDay(date);
    }
    return rows.map((r) => ({ ...r }));
  }

  // Histori per ticker: N tanggal bursa terakhir, terbaru dulu — sama dengan
  // query(tickerHistory/<t>/days, orderBy('date','desc'), limit(N)).
  // daftar tanggal yang dibaca < 10 menit lalu dipakai ulang; halaman yang lama terbuka membaca ulang
  const freshTd = async () => (S.td && S.td.dates && Date.now() - (S.td.at || 0) < 10 * 60e3 ? S.td : tradingDates());

  async function history(tickers, maxDays, { onProgress, force = false } = {}) {
    const td = await freshTd();
    const dates = td.dates.slice(-maxDays).reverse();
    const m = await meta();
    const missing = dates.filter((d) => !(m.days && m.days[d]));
    if (missing.length && !canWrite) throw new Error('arsip belum lengkap (mode hanya-baca)');
    if (!force && missing.length > budgetLeft()) throw new BudgetError(missing.length, budgetLeft());
    if (missing.length) budgetUse(missing.length);
    const want = new Set(tickers);
    const per = new Map();
    let done = 0;
    await mapLimit(dates, 4, async (d) => {
      const rows = await day(d, { force: true });
      per.set(d, rows.filter((r) => want.has(r.ticker)));
      if (onProgress) onProgress(++done, dates.length);
    });
    const out = {};
    tickers.forEach((t) => { out[t] = []; });
    for (const d of dates) for (const r of per.get(d)) out[r.ticker].push(r);
    return out;
  }

  // Bangun arsip tanggal lama di latar belakang (dalam jatah harian). Mengembalikan jumlah yang dibangun.
  async function backfill({ lookback = 80, max = 10 } = {}) {
    if (!canWrite) return 0;
    const td = await freshTd();
    const m = await meta();
    const missing = td.dates.slice(-lookback).filter((d) => !(m.days && m.days[d])).reverse();
    const n = Math.min(max, budgetLeft(), missing.length);
    if (!n) return 0;
    budgetUse(n);
    for (const d of missing.slice(0, n)) await buildDay(d);
    return n;
  }

  async function readTechAt() {
    const s = await fs.getDoc(fs.doc(db, 'systemMeta', 'technicalIndicators')); S.reads++;
    return s.exists() ? s.data().updatedAt || null : null;
  }

  // ---- salinan koleksi kecil: [[id, data], ...] urut id
  async function putMirror(name, entries, metaFields) {
    const list = entries.slice().sort((a, b) => cmpId(a[0], b[0]));
    await putBundle(name, list, (s) => ({ [name]: { s, n: list.length, at: new Date().toISOString(), ...metaFields } }));
    return list;
  }
  function maxStr(entries, field) {
    let mx = null;
    for (const [, d] of entries) { const v = d && d[field]; if (typeof v === 'string' && (mx === null || v > mx)) mx = v; }
    return mx;
  }

  // tickerRollingStats. techAt (opsional) = systemMeta/technicalIndicators.updatedAt yang sudah dibaca.
  async function rolling({ techAt, seed = true } = {}) {
    const m = await meta();
    const e = m.rolling;
    let items = null;
    if (e) {
      // ada yang menulis tickerRollingStats setelah arsip dibuat (mis. versi lama)? → bangun ulang
      const q = addReads(await fs.getDocs(fs.query(fs.collection(db, 'tickerRollingStats'), fs.orderBy('updatedAt', 'desc'), fs.limit(1))));
      const top = q.empty ? null : q.docs[0].data().updatedAt ?? null;
      const fresh = top === (e.maxUpd ?? null) && (techAt === undefined || (techAt ?? null) === (e.techAt ?? null));
      if (fresh) items = await getBundle('rolling', e.s);
    }
    if (!items) {
      if (!seed) return null;
      const all = addReads(await fs.getDocs(fs.collection(db, 'tickerRollingStats')));
      items = all.docs.map((d) => [d.id, d.data()]);
      if (canWrite) {
        try { items = await putRolling(items, { techAt: techAt === undefined ? await readTechAt() : techAt }); }
        catch (err) { log('Arsip rolling gagal ditulis: ' + err.message); }
      }
    }
    return clone(items);
  }
  async function putRolling(entries, { techAt = null } = {}) {
    return putMirror('rolling', entries, { maxUpd: maxStr(entries, 'updatedAt'), techAt: techAt ?? null });
  }

  // tickerIndicators → Map(ticker → data)
  async function indicators({ techAt, seed = true } = {}) {
    const m = await meta();
    const e = m.indicators;
    const ta = techAt === undefined ? await readTechAt() : techAt;
    let items = e && (e.techAt ?? null) === (ta ?? null) ? await getBundle('indicators', e.s) : null;
    if (!items) {
      if (!seed) return null;
      const all = addReads(await fs.getDocs(fs.collection(db, 'tickerIndicators')));
      items = all.docs.map((d) => [d.id, d.data()]);
      if (canWrite) {
        try { items = await putIndicators(items, { techAt: ta }); }
        catch (err) { log('Arsip indikator gagal ditulis: ' + err.message); }
      }
    }
    return new Map(clone(items));
  }
  async function putIndicators(entries, { techAt = null } = {}) {
    return putMirror('indicators', entries, { techAt: techAt ?? null });
  }

  // ownership ringkas untuk Konglo → Map(ticker → {top_holder_group_id, top_holder_group_name}) atau null
  async function ownershipTop() {
    const m = await meta();
    const e = m.ownership;
    if (!e) return null;
    try {
      const q = addReads(await fs.getDocs(fs.query(fs.collection(db, 'ownership'), fs.orderBy('updated_at', 'desc'), fs.limit(1))));
      const top = q.empty ? null : tsMillis(q.docs[0].data().updated_at);
      if (top !== (e.maxUpd ?? null)) return null;
    } catch (err) { log('Cek ownership gagal (arsip tetap dipakai): ' + err.message); }
    const items = await getBundle('ownership', e.s);
    return items ? new Map(clone(items)) : null;
  }
  async function rebuildOwnership() {
    const all = addReads(await fs.getDocs(fs.collection(db, 'ownership')));
    let maxUpd = null;
    const entries = all.docs.map((d) => {
      const x = d.data();
      const u = tsMillis(x.updated_at);
      if (u !== null && (maxUpd === null || u > maxUpd)) maxUpd = u;
      return [d.id, { top_holder_group_id: x.top_holder_group_id ?? null, top_holder_group_name: x.top_holder_group_name ?? null }];
    });
    await putMirror('ownership', entries, { maxUpd });
    return entries.length;
  }

  async function invalidate(name) {
    if (!canWrite) return;
    try { await fs.setDoc(ref('meta'), { [name]: fs.deleteField() }, { merge: true }); S.writes++; if (S.meta) delete S.meta[name]; }
    catch (e) { log(`Gagal menandai arsip ${name} usang: ${e.message}`); }
  }

  return {
    meta, tradingDates, latestDay, useLatest, day, putDay, history, backfill,
    rolling, putRolling, indicators, putIndicators, ownershipTop, rebuildOwnership, invalidate,
    readTechAt, budgetLeft,
    stats: () => ({ reads: S.reads, writes: S.writes, built: S.built, cacheHits: S.cacheHits }),
    resetStats: () => { S.reads = 0; S.writes = 0; S.built = 0; S.cacheHits = 0; },
    archived: () => { const m = S.meta || {}; return { days: Object.keys(m.days || {}).length, known: Object.keys(m.known || {}).length }; },
  };
}
