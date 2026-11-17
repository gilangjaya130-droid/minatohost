# MINATOHOST BOT

Dashboard multi-akun WhatsApp dengan pairing code, QR, pengaturan grup, dan log aktivitas.

## Isi repository

- Website statis untuk Vercel: `index.html`, `style.css`, `app.js`, `config.js`
- Worker WhatsApp yang berjalan terus-menerus: folder `worker/`
- Struktur database dan aturan akses: `supabase/schema.sql`

## Penting: Vercel bukan tempat menjalankan koneksi WhatsApp 24/7

Vercel dipakai untuk website dashboard. Koneksi WhatsApp Baileys berjalan pada worker Node.js terpisah karena koneksi WhatsApp harus tetap hidup. Blueprint worker disediakan di `render.yaml`. Blueprint memakai disk persisten dan paket Render berbayar yang mendukung persistent disk; jangan menganggap worker akan stabil jika dijalankan pada fungsi serverless atau filesystem sementara.

## 1. Siapkan Supabase

1. Buat project baru di Supabase.
2. Buka **SQL Editor**.
3. Salin seluruh isi `supabase/schema.sql`, lalu jalankan.
4. Buka **Project Settings → API**.
5. Catat Project URL, anon/public key, dan service_role key.
6. Jangan pernah memasukkan service_role key ke file website atau membagikannya.

## 2. Siapkan worker WhatsApp

1. Buka Render dan pilih **New → Blueprint**.
2. Hubungkan repository `gilangjaya130-droid/minatohost`.
3. Render akan membaca `render.yaml` di root repository.
4. Isi environment variables yang diminta:
   - `SUPABASE_URL`: Project URL Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY`: service_role key Supabase.
5. Deploy worker. Tunggu sampai statusnya Live.
6. Salin URL worker, misalnya URL HTTPS dari layanan Render.

Worker menggunakan disk persisten untuk menyimpan kredensial sesi WhatsApp. Jangan menghapus disk tersebut jika ingin mempertahankan sesi yang tertaut.

## 3. Siapkan website di Vercel

1. Buka Vercel, pilih **Add New → Project**.
2. Import repository `gilangjaya130-droid/minatohost`.
3. Framework Preset: **Other**.
4. Root Directory: `./`.
5. Build Command: kosongkan.
6. Output Directory: `.`.
7. Deploy.

Setelah worker Live, buka file `config.js` di GitHub lalu tekan edit. Isi:

- `SUPABASE_URL` dengan Project URL Supabase.
- `SUPABASE_ANON_KEY` dengan anon/public key Supabase.
- `BOT_API_URL` dengan URL worker HTTPS.

Simpan perubahan, lalu tunggu Vercel melakukan deployment ulang. URL website akan diberikan Vercel setelah deployment berhasil. Nama domain `minatohost.vercel.app` hanya bisa dipakai jika masih tersedia dan berhasil ditetapkan oleh Vercel.

## 4. Cara memakai

1. Buka website Vercel.
2. Daftar akun dengan email dan password.
3. Masuk ke dashboard.
4. Pilih **Pairing Code** dan masukkan nomor dengan kode negara (contoh format Indonesia: 62812xxxx), atau pilih **Gunakan QR**.
5. Ikuti petunjuk di WhatsApp → Perangkat tertaut.
6. Aktifkan pengaturan grup dari dashboard atau command admin di grup.

## Command bot

- `.menu`, `.ping`, `.runtime`, `.status`, `.owner`
- `.antilink on/off`
- `.welcome on/off`
- `.goodbye on/off`
- `.tagall`, `.hidetag`
- `.kick @tag`, `.promote @tag`, `.demote @tag`

Command moderasi dan pengaturan grup dibatasi untuk admin grup. Bot harus menjadi admin agar dapat menghapus tautan atau mengelola anggota. Menu bot menampilkan **Status: MINATOHOST** dan tidak menampilkan baris server.

## Keamanan dan batasan

- Setiap akun dashboard diverifikasi menggunakan Supabase Auth. Worker memisahkan sesi berdasarkan ID akun.
- Service role key hanya boleh disimpan sebagai environment variable worker.
- Pairing code dan QR adalah akses ke akun WhatsApp. Jangan bagikan kepada siapa pun.
- Gunakan hanya nomor WhatsApp milik sendiri atau yang penggunaannya telah diizinkan.
- Worker ini memakai Baileys, yaitu integrasi WhatsApp Web tidak resmi, bukan WhatsApp Business Platform resmi. Penggunaan dapat memiliki risiko pembatasan akun dan perubahan kompatibilitas. Hindari spam, pesan massal, dan aktivitas yang melanggar ketentuan WhatsApp.
- Website belum bisa dipakai sebelum Supabase, worker, dan Vercel dikonfigurasi. Mengunggah source code ke GitHub saja belum membuat bot online.
