const fs=require('fs');
const d=require('./.store-full.json').docs;
const dates=[...new Set(Object.keys(d).filter(p=>/^dailySummary\/[^/]+$/.test(p)).map(p=>p.split('/')[1]))].sort();
const keepStocks=new Set(dates.slice(-3)), keepHist=new Set(dates.slice(-15));
const out={};
// waktu tulis asli = saat skrip dijalankan; samakan dengan tanggal bursa tiap dokumen (17.30 WIB)
const LAST=dates[dates.length-1];
function fixTime(p,v){
  const m=(p.match(/\d{4}-\d\d-\d\d/)||[])[0]||v.date||v.tradingDate||v.addedDate||LAST;
  const iso=(m>LAST?LAST:m)+'T10:30:00.000Z', ms=Date.parse(iso);
  const walk=x=>{ if(Array.isArray(x)) return x.map(walk); if(x&&typeof x==='object'){ if(Object.keys(x).length===1&&'__ts' in x) return {__ts:ms}; const o={}; for(const k in x) o[k]=walk(x[k]); return o; }
    if(typeof x==='string'&&/^2026-11-28T\d\d:\d\d/.test(x)) return iso; return x; };
  return walk(v);
}
for(const [p,v] of Object.entries(d)){
  const s=p.split('/');
  if(s[0]==='radarBundles') continue;
  if(s[0]==='dailySummary'&&s.length===4&&!keepStocks.has(s[1])) continue;
  if(s[0]==='tickerHistory'&&!keepHist.has(s[3])) continue;
  out[p]=fixTime(p,v);
}
const json={note:'DATA FIKTIF untuk mode demo Radar IDX (dashboard.html?demo=1). Semua kode saham berawalan X dan tidak ada di BEI. Dibuat otomatis dengan menjalankan index.html asli atas pasar simulasi.',generated:'2026-11-28',lastTradingDate:dates[dates.length-1],docs:out};
fs.writeFileSync(require('path').join(__dirname, '../demo-data.json'),JSON.stringify(json));
console.log(Object.keys(out).length, fs.statSync(require('path').join(__dirname, '../demo-data.json')).size);
