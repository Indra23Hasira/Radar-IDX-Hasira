# Mode demo Radar IDX

Buka **`dashboard.html?demo=1`** untuk melihat dashboard tanpa login.

- **Data fiktif.** Semua saham berkode awalan `X` (tidak ada di BEI) dengan nama "PT … (Fiktif) Tbk". Harga, volume, asing, dan bandar berasal dari pasar simulasi, bukan data asli dan bukan rekomendasi.
- **Tanpa Firebase.** `fake-firebase.js` menggantikan Firebase App/Firestore/Auth dan berjalan di memori browser. Isinya dimuat dari `demo-data.json`. Tidak ada permintaan ke server Firebase/Google, dan semua `fetch` ke luar situs ditolak.
- **Perubahan tidak disimpan.** Tombol seperti tambah Watchlist tetap bisa diklik, tetapi hasilnya hilang saat halaman ditutup.
- **Jam dibekukan** di Jumat 27 Nov 2026 18.00 WIB (akhir data demo), jadi hitungan "hari ini" selalu cocok.
- **Disembunyikan di demo:** tab Hold Jk. Panjang (butuh data fundamental dan internet), Import Data, Logout, tautan Stockbit, dan arsip hemat (cache IndexedDB-nya dipakai bersama aplikasi asli).

## Cara `demo-data.json` dibuat

Data **tidak ditulis tangan**. `index.html` asli dijalankan di Chromium headless atas 95 hari bursa fiktif: upload Excel → Tahap 4 → Tahap 5 (30 hari terakhir). Karena itu Top 3, Bandar Accum, Watchlist, dan Rapor Skema di demo adalah keluaran logika aplikasi yang sebenarnya.

```bash
npm i xlsx@0.18.5 playwright           # di folder demo/build
python3 -m http.server 8765 --bind 127.0.0.1   # dari root repo
node demo/build/harness.js             # ±7 menit → demo/build/.store-full.json
node demo/build/trim.js                # → demo/demo-data.json (±3 MB)
```

`gen-market.js` deterministik (seed tetap), jadi hasilnya selalu sama.
