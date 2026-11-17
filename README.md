# MINATOHOST BOT

Dashboard multi-akun WhatsApp dengan Supabase Auth, QR/pairing code, pengaturan, dan worker Baileys.

## Repository
- `index.html`, `style.css`, `app.js`, `config.js`: website dashboard.
- `worker/`: Node.js worker WhatsApp.
- `supabase/schema.sql`: skema database untuk project baru.
- `supabase/migrate_from_previous.sql`: migrasi untuk database yang dibuat dari SQL MINATOHOST versi sebelumnya.

## Database yang sudah dibuat dari SQL versi sebelumnya
Karena database kamu sudah menjalankan SQL yang dikirim sebelumnya, buka Supabase SQL Editor dan jalankan isi file:
`supabase/migrate_from_previous.sql`.
Ini menambahkan kolom yang dibutuhkan worker, termasuk status waiting_qr, pengaturan bot aktif, dan event log.

## Deploy website ke Vercel
1. Buka https://vercel.com/new
2. Import repository `gilangjaya130-droid/minatohost`.
3. Framework Preset: Other; Root Directory: `./`.
4. Build Command kosong; Output Directory: `.`.
5. Deploy.
6. Vercel akan menampilkan URL website setelah deployment selesai.

Sebelum website bisa login, edit `config.js` di GitHub:
- `SUPABASE_URL`: `https://ixjlmutcnmylrafheayi.supabase.co`
- `SUPABASE_ANON_KEY`: Supabase Project Settings → API Keys → publishable key (atau legacy anon public key).
- `BOT_API_URL`: URL HTTPS worker setelah worker di-host.

Publishable/anon key boleh ada di frontend. Jangan pernah menaruh `service_role` / secret key di frontend.

## Deploy worker WhatsApp
Vercel hanya meng-host website; koneksi WhatsApp perlu worker Node.js persisten.
1. Buka https://render.com dan pilih New → Blueprint.
2. Hubungkan repository ini; Render membaca `render.yaml`.
3. Isi `SUPABASE_URL` dengan URL project dan `SUPABASE_SERVICE_ROLE_KEY` dengan service_role key dari Supabase.
4. Deploy worker. Blueprint memakai persistent disk dan paket berbayar yang mendukung disk persisten.
5. Salin URL HTTPS worker, lalu isi `BOT_API_URL` di `config.js` dan commit.

Jangan membagikan password, service_role key, atau file sesi WhatsApp.

## Perintah bot
`.menu`, `.owner`, `.status`, `.ping`, `.runtime`, `.antilink on/off`, `.welcome on/off`, `.goodbye on/off`, `.tagall`, `.hidetag`, `.kick`, `.promote`, `.demote`.
Perintah pengelolaan anggota hanya berjalan jika pengirim dan bot memiliki hak admin yang sesuai.
