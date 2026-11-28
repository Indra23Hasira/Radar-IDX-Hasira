// =====================================================================
// fake-firebase.js — pengganti Firebase (App + Firestore + Auth) yang berjalan
// SEPENUHNYA di memori browser. Dipakai mode demo (dashboard.html?demo=1):
//  - tidak ada satu pun permintaan ke server Firebase/Google,
//  - data awal dimuat dari demo/demo-data.json (data saham FIKTIF),
//  - perubahan (misal tambah Watchlist) hanya hidup selama halaman terbuka.
// API yang disediakan = subset modular Firebase v10 yang dipakai aplikasi ini.
// =====================================================================

const STORE = globalThis.__FAKE_FIRESTORE__ || (globalThis.__FAKE_FIRESTORE__ = new Map());

// ---------- Timestamp & sentinel ----------
export class Timestamp {
  constructor(seconds, nanoseconds = 0){ this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static fromMillis(ms){ return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  static fromDate(d){ return Timestamp.fromMillis(d.getTime()); }
  static now(){ return Timestamp.fromMillis(Date.now()); }
  toMillis(){ return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate(){ return new Date(this.toMillis()); }
  valueOf(){ return String(this.toMillis()).padStart(16, '0'); }
}
const SERVER_TS = { __sentinel: 'serverTimestamp' };
const DELETE = { __sentinel: 'delete' };
export function serverTimestamp(){ return SERVER_TS; }
export function deleteField(){ return DELETE; }
export function documentId(){ return '__name__'; }

function clone(v){
  if(v === null || typeof v !== 'object' || v === SERVER_TS || v === DELETE) return v;
  if(v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if(v instanceof Date) return new Date(v.getTime());
  if(Array.isArray(v)) return v.map(clone);
  const o = {}; for(const k of Object.keys(v)) o[k] = clone(v[k]); return o;
}
function resolveSentinels(v){
  if(v === SERVER_TS) return Timestamp.now();
  if(v === null || typeof v !== 'object' || v instanceof Timestamp) return v;
  if(Array.isArray(v)) return v.map(resolveSentinels);
  const o = {}; for(const k of Object.keys(v)){ if(v[k] !== DELETE) o[k] = resolveSentinels(v[k]); } return o;
}
function deepMerge(target, src){
  for(const k of Object.keys(src)){
    const v = src[k];
    if(v === DELETE){ delete target[k]; continue; }
    if(v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && v !== SERVER_TS
       && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k]) && !(target[k] instanceof Timestamp)){
      deepMerge(target[k], v);
    }else{
      target[k] = resolveSentinels(v);
    }
  }
  return target;
}

// ---------- referensi ----------
export function initializeApp(cfg){ return { name: '[DEMO]', options: cfg || {} }; }
export function getFirestore(){ return { type: 'firestore', __demo: true }; }
const isDb = x => x && x.type === 'firestore';
const randId = () => Array.from({ length: 20 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');

function joinPath(base, segs){
  const parts = (base ? base.split('/') : []).concat(...segs.map(s => String(s).split('/'))).filter(Boolean);
  return parts.join('/');
}
export function collection(parent, ...segs){
  const path = joinPath(isDb(parent) ? '' : parent.path, segs);
  return { type: 'collection', path, id: path.split('/').pop() };
}
export function doc(parent, ...segs){
  let path;
  if(isDb(parent)) path = joinPath('', segs);
  else if(parent.type === 'collection') path = joinPath(parent.path, segs.length ? segs : [randId()]);
  else path = joinPath(parent.path, segs);
  return { type: 'document', path, id: path.split('/').pop(), parent: { path: path.split('/').slice(0, -1).join('/') } };
}

// ---------- snapshot ----------
function docSnap(path){
  const data = STORE.get(path);
  const ref = doc({ type: 'firestore' }, path);
  return { id: ref.id, ref, exists: () => data !== undefined, data: () => (data === undefined ? undefined : clone(data)), get: f => (data ? getField(data, f) : undefined) };
}
function getField(obj, field){
  if(field === '__name__') return obj.__id;
  return String(field).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ---------- baca ----------
export async function getDoc(ref){ return docSnap(ref.path); }

export function where(field, op, value){ return { kind: 'where', field, op, value }; }
export function orderBy(field, dir = 'asc'){ return { kind: 'orderBy', field, dir }; }
export function limit(n){ return { kind: 'limit', n }; }
export function query(ref, ...constraints){ return { type: 'query', path: ref.path, constraints: (ref.constraints || []).concat(constraints) }; }

function cmp(a, b){
  if(a instanceof Timestamp) a = a.toMillis();
  if(b instanceof Timestamp) b = b.toMillis();
  if(a === b) return 0;
  if(a === undefined || a === null) return -1;
  if(b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}
function test(v, op, x){
  switch(op){
    case '==': return cmp(v, x) === 0;
    case '!=': return v !== undefined && cmp(v, x) !== 0;
    case '>': return v !== undefined && v !== null && cmp(v, x) > 0;
    case '>=': return v !== undefined && v !== null && cmp(v, x) >= 0;
    case '<': return v !== undefined && v !== null && cmp(v, x) < 0;
    case '<=': return v !== undefined && v !== null && cmp(v, x) <= 0;
    case 'in': return Array.isArray(x) && x.some(y => cmp(v, y) === 0);
    case 'not-in': return Array.isArray(x) && !x.some(y => cmp(v, y) === 0);
    case 'array-contains': return Array.isArray(v) && v.some(y => cmp(y, x) === 0);
    case 'array-contains-any': return Array.isArray(v) && Array.isArray(x) && v.some(y => x.some(z => cmp(y, z) === 0));
    default: throw new Error('Operator query tidak didukung di mode demo: ' + op);
  }
}
function childrenOf(colPath){
  const depth = colPath.split('/').length + 1, pre = colPath + '/';
  const out = [];
  for(const [p, d] of STORE){ if(p.startsWith(pre) && p.split('/').length === depth) out.push({ p, d: { ...d, __id: p.split('/').pop() } }); }
  return out;
}
export async function getDocs(q){
  let rows = childrenOf(q.path);
  const cons = q.constraints || [];
  for(const c of cons) if(c.kind === 'where') rows = rows.filter(r => test(getField(r.d, c.field), c.op, c.value));
  const orders = cons.filter(c => c.kind === 'orderBy');
  // Firestore: orderBy pada field yang tidak ada → dokumen dibuang
  for(const o of orders) if(o.field !== '__name__') rows = rows.filter(r => getField(r.d, o.field) !== undefined);
  rows.sort((a, b) => {
    for(const o of orders){ const c = cmp(getField(a.d, o.field), getField(b.d, o.field)); if(c) return o.dir === 'desc' ? -c : c; }
    return a.p < b.p ? -1 : a.p > b.p ? 1 : 0;
  });
  const lim = cons.find(c => c.kind === 'limit');
  if(lim) rows = rows.slice(0, lim.n);
  const docs = rows.map(r => docSnap(r.p));
  return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
}
export async function getCountFromServer(q){ const s = await getDocs(q); return { data: () => ({ count: s.size }) }; }

// ---------- tulis (hanya di memori) ----------
function writeSet(path, data, opts){
  if(opts && opts.merge && STORE.has(path)) STORE.set(path, deepMerge(clone(STORE.get(path)), data));
  else STORE.set(path, resolveSentinels(clone(data)));
}
function writeUpdate(path, data){
  if(!STORE.has(path)){ const e = new Error('No document to update: ' + path); e.code = 'not-found'; throw e; }
  const cur = clone(STORE.get(path));
  for(const k of Object.keys(data)){
    const keys = k.split('.'); let o = cur;
    for(let i = 0; i < keys.length - 1; i++){ if(!o[keys[i]] || typeof o[keys[i]] !== 'object') o[keys[i]] = {}; o = o[keys[i]]; }
    const last = keys[keys.length - 1];
    if(data[k] === DELETE) delete o[last]; else o[last] = resolveSentinels(clone(data[k]));
  }
  STORE.set(path, cur);
}
export async function setDoc(ref, data, opts){ writeSet(ref.path, data, opts); }
export async function updateDoc(ref, data){ writeUpdate(ref.path, data); }
export async function deleteDoc(ref){ STORE.delete(ref.path); }
export async function addDoc(colRef, data){ const r = doc(colRef); writeSet(r.path, data); return r; }
export function writeBatch(){
  const ops = [];
  return {
    set(ref, data, opts){ ops.push(() => writeSet(ref.path, data, opts)); return this; },
    update(ref, data){ ops.push(() => writeUpdate(ref.path, data)); return this; },
    delete(ref){ ops.push(() => STORE.delete(ref.path)); return this; },
    async commit(){ ops.forEach(f => f()); },
  };
}

// ---------- auth (selalu "masuk" sebagai pengguna demo) ----------
const DEMO_USER = { uid: 'demo-user', email: 'Mode Demo — data fiktif', displayName: 'Demo' };
export function getAuth(){ return { currentUser: DEMO_USER }; }
export function onAuthStateChanged(_auth, cb){ setTimeout(() => cb(DEMO_USER), 0); return () => {}; }
export async function signInWithEmailAndPassword(){ return { user: DEMO_USER }; }
export async function signOut(){ /* demo: tidak ada sesi */ }

// ---------- muat / ekspor isi database ----------
function revive(v){
  if(v === null || typeof v !== 'object') return v;
  if(Array.isArray(v)) return v.map(revive);
  const ks = Object.keys(v);
  if(ks.length === 1 && ks[0] === '__ts') return Timestamp.fromMillis(v.__ts);
  const o = {}; for(const k of ks) o[k] = revive(v[k]); return o;
}
function serialize(v){
  if(v === null || typeof v !== 'object') return v;
  if(v instanceof Timestamp) return { __ts: v.toMillis() };
  if(Array.isArray(v)) return v.map(serialize);
  const o = {}; for(const k of Object.keys(v)) o[k] = serialize(v[k]); return o;
}
export function __loadStore(json){ STORE.clear(); for(const [p, d] of Object.entries(json.docs || {})) STORE.set(p, revive(d)); }
export function __dumpStore(filterFn){
  const docs = {};
  for(const [p, d] of STORE) if(!filterFn || filterFn(p, d)) docs[p] = serialize(d);
  return { docs };
}
export function __storeSize(){ return STORE.size; }
