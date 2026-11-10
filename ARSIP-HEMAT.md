# Arsip hemat Firestore (radar-bundle.js)

Project Firebase `radar-idx-hasira` memakai paket gratis (Spark): ±50.000 baca dokumen per hari, dipakai bersama
Radar IDX, Dashboard, Radar Konglo, Radar Pengendali dan Radar-DayTrade. Kuota reset tengah malam waktu Pasifik
(**14:00 WIB** Mar–Nov, **15:00 WIB** Nov–Mar).

Kuota dihitung per dokumen. Cara lama membaca histori 20 hari untuk ±800 saham = ±16.000 dokumen sekali Step 4,
Backtest 40 hari ±30.000, Diagnosa 120 hari bisa >80.000 (melebihi kuota harian sendirian).

## Cara kerja

Saat upload Excel, selain menulis seperti biasa, Radar IDX juga menyimpan **1 dokumen berisi semua saham tanggal itu**
(dikompres) di koleksi `radarBundles`. Histori 20 hari = 20 dokumen, dan yang sudah pernah dibaca disimpan di browser
(IndexedDB), jadi berikutnya hampir 0 baca. Hal yang sama untuk `tickerRollingStats`, `tickerIndicators`, dan ringkasan
ownership untuk Konglo.

- Koleksi lama **tetap ditulis** seperti biasa. Arsip hanya salinan untuk dibaca.
- Hasil **sama persis** dengan cara lama (diuji: lihat bawah). Kalau arsip tidak ada, usang, atau gagal dibaca,
  aplikasi otomatis memakai cara lama.
- Upload / Step 4 / Step 5 dari versi aplikasi lama (tab yang masih terbuka) terdeteksi, arsip dibangun ulang otomatis.
- Tanggal lama diarsipkan bertahap: Step 4 pertama membangun 20 tanggal terakhir, lalu tiap Step 4 menambah 6 tanggal
  lama (maks 30 tanggal per hari kuota). Backtest/Diagnosa yang butuh tanggal yang belum diarsipkan menampilkan pilihan
  "jalankan besok" atau "bangun sekarang".

## Setup (sekali)

Firebase Console → project **radar-idx-hasira** → Firestore Database → **Rules** → tempel isi
`firestore.rules.radarbundles` di dalam `match /databases/{database}/documents { … }` → **Publish**.

Sebelum rules dipasang aplikasi tetap jalan normal (cara lama) dan halaman upload menampilkan peringatan
"Arsip hemat … gagal ditulis".

## Perkiraan baca per hari (±950 saham)

| Kegiatan | Cara lama | Arsip hemat |
| --- | --- | --- |
| Upload + Step 4 | ±17.000 | ±100–400 |
| Step 4 hitung ulang | ±17.000 | ±100–300 |
| Backtest 40 hari | ±30.000 | ±40 (0 kalau sudah di cache browser) |
| Diagnosa 120 hari | ±80.000+ | ±150 |
| Buka Dashboard | ±2.500 (pertama) / ±800 | ±50 + jumlah watchlist |
| Buka Radar Konglo | ±1.800 | ±4 |
| Universe Radar-DayTrade | ±200 per run | ±4 per run |

Hari pertama setelah aktif lebih mahal sekali (membangun arsip ±25 tanggal ≈ ±24.000 baca), setelah itu hemat.

## Uji yang dijalankan (10 Nov 2026)

Firestore tiruan + Chromium, data sintetis 260 saham × 53 hari, skenario: upload Excel → Step 4 → Step 5 → Backtest 40 →
Diagnosa 120 → Step 4 ulang → Dashboard (radar, watchlist, statistik, rapor, hold) → Konglo → Pengendali → Konglo, dua hari
berturut-turut. Isi database akhir dan semua tampilan **identik** dengan versi lama; skenario rules belum dipasang juga
identik (memakai cara lama). Total baca hari ke-2 untuk skenario itu: ±33.000 → ±560.
