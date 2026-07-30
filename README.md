# AI Video Intelligence Studio

Aplikasi 100% client-side dengan dua mode:

1. **🎬 Rekonstruksi Video Viral** — unggah video viral, dapatkan skor viral,
   bedah kreatif, breakdown scene, dan prompt produksi (image grid storyboard,
   OmniFlash, Kling, Veo, Hailuo) yang merekonstruksi SETIA video aslinya —
   bukan versi kreatif baru — dengan durasi dikunci 10–30 detik. Mode
   "🔥 Buat Lebih Baik" terpisah tersedia kalau memang ingin versi yang
   dioptimalkan/berbeda.
2. **📸 Promosi Usaha / Jualan** — unggah beberapa foto tempat/produk, isi
   info usaha singkat, dan dapatkan konsep + prompt video promosi yang
   merujuk langsung ke foto-foto tersebut, durasi 10–30 detik.

Semua isi yang dihasilkan AI (skor, analisis, prompt) ditulis dalam
**Bahasa Indonesia yang natural**, bukan terjemahan kaku ala mesin.

Tiga file. Tanpa build step, tanpa backend, tanpa database.

```
index.html
style.css
script.js
```

## Cara kerja

1. **Ingest lokal (tanpa AI, tanpa jaringan):** video/foto dibaca langsung
   di browser kamu — durasi, resolusi, frame rate, deteksi scene dari video
   (atau resize foto untuk mode promosi).
2. **Analisis AI (provider pilihanmu, API key milikmu sendiri):** thumbnail
   scene/foto + info terkait dikirim langsung dari browser ke provider yang
   kamu hubungkan, yang membalas dengan JSON berisi seluruh hasil analisis
   dan prompt.
3. **🔥 Buat Lebih Baik** (khusus mode video): panggilan AI kedua yang
   membuat konsep alternatif yang lebih kuat — bukan salinan video asli.

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
- **"Error ... model ... is no longer available"** — Google/OpenAI baru saja
  mematikan model itu untuk akun baru — pilih model lain di dropdown Model.
- **"Video ini tidak bisa dibaca browser"** — coba format MP4/MOV/WEBM lain.

## Batasan yang perlu diketahui

- Video: maksimal 12 scene representatif dikirim ke AI per analisis, supaya
  tetap cepat & murah.
- Promosi: maksimal 10 foto per analisis.
- Frame rate video hanya terdeteksi di browser berbasis Chromium; browser
  lain akan menampilkan "Tidak tersedia".
- Video/foto kamu tidak pernah diunggah ke mana pun kecuali ke provider AI
  yang kamu hubungkan sendiri, dan hanya saat kamu menekan tombol analisis.
