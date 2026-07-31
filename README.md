# AI Video Intelligence Studio

Aplikasi 100% client-side dengan tiga mode, semuanya menghasilkan output
dalam alur DUA PROMPT terpisah:

- **Prompt 1 — Master Prompt (khusus Image Grid Storyboard).** Tempel ke
  ChatGPT. ChatGPT akan bertanya dulu: langsung buat gambar storyboard, atau
  revisi promptnya dulu — instruksi ini sudah tertanam di dalam Prompt 1
  sendiri.
- **Prompt 2 — Video Generator (dipakai belakangan).** Baru dipakai SETELAH
  gambar Image Grid Storyboard dari Prompt 1 sudah final/disetujui.
  Lampirkan gambar storyboard itu bersama Prompt 2 untuk mendapatkan prompt
  JSON siap pakai di OmniFlash, Veo, Kling, atau Hailuo.

## Tiga mode

1. **🎬 Rekonstruksi Video Viral** — unggah video viral, dapat skor viral,
   bedah kreatif, breakdown scene, lalu Prompt 1 & 2 yang merekonstruksi
   SETIA video aslinya (bukan versi kreatif baru — durasi dikunci 10–30
   detik). Mode "🔥 Buat Lebih Baik" terpisah tersedia untuk versi yang
   dioptimalkan/berbeda.
2. **📸 Promosi Usaha / Jualan** — unggah video REFERENSI (contoh gaya
   promosi yang kamu suka, bukan video usahamu sendiri), isi info usaha
   singkat, dan dapatkan Prompt 1 & 2 yang menerapkan teknik promosi dari
   video referensi ke usahamu. Foto/video ASLI usahamu tetap kamu lampirkan
   sendiri langsung di ChatGPT bersama Prompt 1 — aplikasi ini tidak pernah
   melihatnya.
3. **💡 Video Bebas (dari Ide)** — tidak ada video referensi sama sekali.
   Cukup isi judul dan tema (wajib); durasi, gaya visual, dan isi materi
   opsional — AI akan merekomendasikan atau menyusun sendiri bagian yang
   kosong, lalu menghasilkan Prompt 1 & 2 yang sama. Durasi di mode ini
   BEBAS (detik sampai menit), tidak dikunci 10–30 detik seperti dua mode
   lainnya.

Semua isi yang dihasilkan AI ditulis dalam **Bahasa Indonesia yang natural**,
bukan terjemahan kaku ala mesin.

Tiga file. Tanpa build step, tanpa backend, tanpa database.

```
index.html
style.css
script.js
```

## Pilih provider

Klik **Hubungkan API key gratis** di header:

- **Google Gemini — gratis, tanpa kartu kredit.** Ambil key di
  [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
  Google cukup sering ganti/pensiunkan model gratisnya — kalau ada error
  "model tidak tersedia", tinggal ganti pilihan model di dropdown yang sama.
- **OpenAI — berbayar.** Perlu kartu + top-up minimal (~$5). Ambil key di
  [platform.openai.com/api-keys](https://platform.openai.com/api-keys).

Key disimpan terpisah per provider di `localStorage` browser ini — tidak
pernah dikirim ke pihak lain selain provider yang kamu pilih sendiri.

## Deploy ke GitHub Pages

1. Push `index.html`, `style.css`, `script.js` ke root repo GitHub.
2. **Settings → Pages** → Source: branch utama / `(root)` → Save.
3. Situsnya live di `https://<username>.github.io/<repo>/` dalam 1-2 menit.

## Troubleshooting

- **"[Provider] menolak key ini (HTTP 401/403)"** — key salah, atau (khusus
  Gemini) kena isu `API_KEY_SERVICE_BLOCKED` di project baru — coba buat key
  di project Google Cloud yang berbeda.
- **"Kena limit dari [Provider]"** — sudah kena rate limit gratis, tunggu
  sebentar lalu coba lagi, atau ganti ke model lain di dropdown.
- **"Error ... model ... is no longer available"** — provider baru saja
  mematikan model itu untuk akun baru — pilih model lain di dropdown Model.
- **"Jawaban AI terpotong karena kepanjangan"** — jarang terjadi karena
  batas token sudah dilonggarkan, tapi kalau masih muncul, coba lagi atau
  pakai video/isi materi yang lebih ringkas.
- **"Video ini tidak bisa dibaca browser"** — coba format MP4/MOV/WEBM lain.

## Batasan yang perlu diketahui

- Mode video & promosi: maksimal 12 scene representatif dikirim ke AI per
  analisis, supaya tetap cepat & murah.
- Video/foto asli usahamu tidak pernah diunggah ke aplikasi ini — hanya
  video REFERENSI (mode promosi) atau video viral (mode rekonstruksi) yang
  diproses. Prompt hasilnya secara eksplisit meminta kamu melampirkan
  foto/video asli langsung di ChatGPT.
- Frame rate video hanya terdeteksi di browser berbasis Chromium; browser
  lain akan menampilkan "Tidak tersedia".
