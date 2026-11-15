# Tournament Hub

## Jalankan untuk uji lokal

Gunakan Node.js 18 atau lebih baru. Di PowerShell, dari folder proyek:

```powershell
$env:ADMIN_PASSWORD = "isi-password-admin-sendiri"
npm start
```

Buka `http://localhost:3000/`. Penonton bisa membuka menu utama, Spin Wheel, bagan, dan rekap juara. Admin memilih **Masuk Admin** untuk mengatur peserta, bagan, dan hasil. Password admin dibaca dari environment, tidak disimpan di kode.

Jika sudah masuk sebagai admin, gunakan **Keluar Admin** agar kembali ke mode penonton. Perangkat lain dapat membuka alamat server yang sama di jaringan.

## Untuk dipakai melalui internet

Deploy server Node.js ke hosting yang mendukung Node.js dan gunakan HTTPS. Atur `ADMIN_PASSWORD`, `PORT` (opsional), serta `NODE_ENV=production` di konfigurasi hosting. Jangan menyimpan password di file proyek. Data turnamen tersimpan di `data/tournament.json`; sertakan file itu dalam backup.

Untuk Render, gunakan runtime Node. Perintah build dapat diisi `npm install` dan **Start Command** harus `npm start` (atau `node server.js`), bukan `gunicorn`. Atur `ADMIN_PASSWORD` di Environment Variables Render.
