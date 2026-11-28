// Pasar saham FIKTIF untuk mode demo. Semua kode diawali "X" (tidak ada saham BEI yang diawali X),
// nama "PT ... (Fiktif) Tbk". Deterministik (seed tetap) supaya demo bisa dibangun ulang sama persis.
'use strict';
let seed = 20261128;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while(!u) u = rnd(); while(!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pick = a => a[Math.floor(rnd() * a.length)];
const tick = p => p < 200 ? 1 : p < 500 ? 2 : p < 2000 ? 5 : p < 5000 ? 10 : 25;
const rt = p => Math.max(50, Math.round(p / tick(p)) * tick(p));

const BULAN = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];

function tradingDays(endISO, n){
  const out = []; const d = new Date(endISO + 'T00:00:00Z');
  while(out.length < n){ const w = d.getUTCDay(); if(w && w < 6) out.unshift(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate() - 1); }
  return out;
}

function build({ endDate = '2026-11-27', nDays = 230, nUpload = 95, nStocks = 170 } = {}){
  const dates = tradingDays(endDate, nDays);
  const uploadFrom = nDays - nUpload;
  // faktor pasar: tenang naik pelan + beberapa episode jatuh (memicu kondisi pantulan) lalu memantul
  const mkt = dates.map(() => 0.04 + gauss() * 0.55);
  const shocks = [uploadFrom + 8, uploadFrom + 30, uploadFrom + 52, uploadFrom + 74, uploadFrom + 86, 60, 110];
  shocks.forEach(s => {
    for(let k = 0; k < 4 && s + k < nDays; k++) mkt[s + k] += -1.6 - rnd() * 1.4;
    for(let k = 4; k < 10 && s + k < nDays; k++) mkt[s + k] += 0.45 + rnd() * 0.5;
  });

  const W1 = ['Arta','Bumi','Cakra','Dirga','Eka','Fajar','Gemilang','Harapan','Intan','Jaya','Karya','Lestari','Mulia','Nusa','Omega','Pratama','Rimba','Sinar','Tirta','Utama','Wahana','Yasa','Bahari','Cipta','Dharma','Graha','Kencana','Mega','Prima','Sentosa'];
  const W2 = ['Energi','Pangan','Logistik','Properti','Tambang','Farma','Digital','Semen','Kimia','Ritel','Agro','Finansial','Media','Konstruksi','Tekstil','Otomotif','Infra','Telko','Minyak','Baja'];
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWYZ';
  const used = new Set(); const stocks = [];
  for(let i = 0; i < nStocks; i++){
    const a = pick(W1), b = pick(W2);
    let code = 'X' + a[0] + b[0] + L[Math.floor(rnd() * L.length)];
    while(used.has(code)) code = 'X' + L[Math.floor(rnd() * L.length)] + L[Math.floor(rnd() * L.length)] + L[Math.floor(rnd() * L.length)];
    used.add(code);
    const illiquid = i >= nStocks - 22;
    stocks.push({
      code, name: `PT ${a} ${b} (Fiktif) Tbk`,
      beta: 0.6 + rnd() * 0.9, vol: 1.2 + rnd() * 2.4,
      price: rt(illiquid && rnd() < .4 ? 60 + rnd() * 60 : Math.exp(Math.log(120) + rnd() * Math.log(9000 / 120))),
      valueBase: illiquid ? 2e8 + rnd() * 6e8 : 1.5e9 + Math.exp(rnd() * Math.log(40)) * 1e9,
      tradeSize: 5e6 + rnd() * 25e6, listed: Math.round((1 + rnd() * 30) * 1e9), foreignShare: 0.15 + rnd() * 0.35,
      events: [],
    });
  }
  // episode per saham: akumulasi diam-diam (lalu naik) atau breakout heboh (lalu melemah)
  stocks.forEach(s => {
    let t = 25 + Math.floor(rnd() * 20);
    while(t < nDays - 5){
      const type = rnd() < 0.55 ? 'accum' : 'breakout';
      s.events.push({ type, start: t, len: type === 'accum' ? 7 + Math.floor(rnd() * 5) : 1 });
      t += 18 + Math.floor(rnd() * 30);
    }
  });

  const series = {}; // code -> [{date, open, high, low, close, volume, value, freq, fb, fs, bidV, offV, prev}]
  stocks.forEach(s => {
    let p = s.price; const rows = [];
    for(let i = 0; i < nDays; i++){
      let drift = 0, volMul = 1, valMul = 0.8 + rnd() * 0.4, fBias = 0, bidBias = 0;
      for(const e of s.events){
        if(e.type === 'accum'){
          if(i >= e.start && i < e.start + e.len){ volMul = 0.45; valMul *= 1.2 + 0.08 * (i - e.start); fBias = 0.22; bidBias = 0.25; drift = 0.05; }
          else if(i >= e.start + e.len && i < e.start + e.len + 9){ drift = 0.55; fBias = 0.1; valMul *= 1.3; }
        }else{
          if(i === e.start){ drift = 5 + rnd() * 4; valMul *= 3.5; fBias = 0.15; }
          else if(i > e.start && i <= e.start + 9){ drift = -0.5; valMul *= 1.4; fBias = -0.08; }
        }
      }
      const r = (s.beta * mkt[i] + drift + gauss() * s.vol * volMul) / 100;
      const prev = p;
      const gapR = rnd() < 0.5 ? 0 : gauss() * 0.006 * volMul;
      const open = rt(prev * (1 + gapR));
      let close = rt(Math.max(prev * 0.75, Math.min(prev * 1.25, prev * (1 + r))));
      const span = Math.abs(gauss()) * s.vol * volMul * 0.006 * prev + tick(prev);
      const high = rt(Math.max(open, close) + span * rnd());
      const low = rt(Math.max(tick(prev), Math.min(open, close) - span * rnd()));
      p = close;
      const value = Math.round(s.valueBase * valMul);
      const volume = Math.max(100, Math.round(value / close / 100) * 100);
      const fTot = value * s.foreignShare;
      const fb = Math.round(volume * s.foreignShare * (0.5 + fBias + gauss() * 0.08) );
      const fs = Math.round(volume * s.foreignShare * (0.5 - fBias + gauss() * 0.08));
      const bidV = Math.round(volume * (0.05 + rnd() * 0.1) * (1 + bidBias));
      const offV = Math.round(volume * (0.05 + rnd() * 0.1) * (1 - bidBias * 0.6));
      rows.push({ date: dates[i], prev, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume, value,
        freq: Math.max(5, Math.round(value / s.tradeSize)), fb: Math.max(0, fb), fs: Math.max(0, fs), bidV: Math.max(0, bidV), offV: Math.max(0, offV) });
      void fTot;
    }
    series[s.code] = rows;
  });
  return { dates, uploadFrom, stocks, series };
}

function indoDate(iso){ const [y, m, d] = iso.split('-'); return `${parseInt(d, 10)} ${BULAN[parseInt(m, 10) - 1]} ${y}`; }

// baris Excel ringkasan saham harian (format sama dengan file RS BEI yang diunggah ke Radar IDX)
function excelRows(mk, dayIdx){
  return mk.stocks.map(s => {
    const r = mk.series[s.code][dayIdx];
    return {
      'No': null, 'Kode Saham': s.code, 'Nama Perusahaan': s.name, 'Remarks': '',
      'Sebelumnya': r.prev, 'Open Price': r.open, 'Tanggal Perdagangan Terakhir': indoDate(r.date), 'First Trade': r.open,
      'Tertinggi': r.high, 'Terendah': r.low, 'Penutupan': r.close, 'Selisih': r.close - r.prev,
      'Volume': r.volume, 'Nilai': r.value, 'Frekuensi': r.freq, 'Index Individual': 100,
      'Offer': r.close + tick(r.close), 'Offer Volume': r.offV, 'Bid': r.close, 'Bid Volume': r.bidV,
      'Listed Shares': s.listed, 'Tradeble Shares': Math.round(s.listed * 0.4), 'Weight For Index': Math.round(s.listed * 0.4),
      'Foreign Sell': r.fs, 'Foreign Buy': r.fb, 'Non Regular Volume': 0, 'Non Regular Value': 0, 'Non Regular Frequency': 0,
    };
  });
}

// jawaban "Yahoo chart" fiktif (dipakai Tahap 5 saat membangun data demo; TIDAK dipakai di mode demo)
function yahooChart(mk, code, upToIdx){
  const rows = mk.series[code];
  if(!rows) return { chart: { result: null, error: { description: 'not found' } } };
  const from = Math.max(0, upToIdx - 125);
  const sl = rows.slice(from, upToIdx + 1);
  return { chart: { result: [{ timestamp: sl.map(r => Date.parse(r.date + 'T02:00:00Z') / 1000),
    indicators: { quote: [{ open: sl.map(r => r.open), high: sl.map(r => r.high), low: sl.map(r => r.low), close: sl.map(r => r.close), volume: sl.map(r => r.volume) }] } }], error: null } };
}

module.exports = { build, excelRows, yahooChart, indoDate };
