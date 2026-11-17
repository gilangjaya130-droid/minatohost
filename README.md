# MINATOHOST BOT

Dashboard multi-akun WhatsApp dengan Supabase Auth, QR/pairing code, dan worker Baileys.

## Struktur repository
- `public/`: website dashboard.
- `worker/`: Node.js worker WhatsApp.
- `supabase/schema.sql`: skema database untuk project baru.
- `supabase/migrate_from_previous.sql`: migrasi database dari SQL MINATOHOST sebelumnya.

## Database
Jika database sudah menjalankan SQL versi sebelumnya, buka Supabase SQL Editor dan jalankan:
`supabase/migrate_from_previous.sql`.

Untuk project database baru, jalankan `supabase/schema.sql`.

## Deploy website ke Vercel
1. Import repository `gilangjaya130-droid/minatohost` di Vercel.
2. Framework Preset: Other; Root Directory: `./`.
3. Build Command kosong; Output Directory: `public`.
4. Pastikan `public/config.js` berisi Supabase URL, Supabase publishable/anon key, dan URL HTTPS worker.
5. Deploy website.

Publishable/anon key boleh ada di frontend. Jangan pernah menaruh `service_role` / secret key di frontend.

## Deploy worker WhatsApp
Vercel hanya meng-host website. Koneksi WhatsApp memerlukan worker Node.js yang berjalan terus dan penyimpanan sesi persisten.

Baca panduan lengkap di [worker/DEPLOY.md](worker/DEPLOY.md). Worker membutuhkan Node.js 20+ atau Docker, HTTPS, volume persisten, serta environment variables privat. Host gratis yang tidur atau menghapus file sesi dapat memutus koneksi WhatsApp.

Jangan membagikan password, service_role key, pairing code, QR, atau file sesi WhatsApp.

## Perintah bot
`.menu`, `.owner`, `.status`, `.ping`, `.runtime`, `.antilink on/off`, `.welcome on/off`, `.goodbye on/off`, `.tagall`, `.hidetag`, `.kick`, `.promote`, `.demote`.

Perintah pengelolaan anggota hanya berjalan jika pengirim dan bot memiliki hak admin yang sesuai.
