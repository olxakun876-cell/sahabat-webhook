# WhatsApp Cloud API — Webhook Receiver

Endpoint webhook untuk WhatsApp Business Cloud API: menangani **verifikasi GET** dari Meta, **validasi signature** `X-Hub-Signature-256`, dan **mencetak pesan masuk** ke console.

## Struktur

| File | Fungsi |
| --- | --- |
| `server.js` | Express app: `GET /webhook`, `POST /webhook`, `GET /health` |
| `scripts/send-test-message.js` | Mengirim payload webhook palsu (sudah ditandatangani) ke server lokal |
| `.env.example` | Template konfigurasi (salin menjadi `.env`) |

## 1. Prasyarat

- Node.js 18 atau lebih baru (`node --version`)
- App Secret dari **Meta App Dashboard → App settings → Basic → App secret**
- Verify token yang akan dipakai: `sahabat_purchasing_rahasia_123` (boleh diganti)

## 2. Instalasi

```powershell
cd whatsapp-webhook
npm install
Copy-Item .env.example .env
```

Buka `.env`, isi `WHATSAPP_APP_SECRET` dengan App Secret asli:

```dotenv
PORT=3000
WHATSAPP_VERIFY_TOKEN=sahabat_purchasing_rahasia_123
WHATSAPP_APP_SECRET=app_secret_anda
```

> `.env` sudah masuk `.gitignore`. Jangan pernah commit nilainya.

## 3. Menjalankan

```powershell
npm start
# atau, dengan auto-reload saat file berubah:
npm run dev
```

Output yang diharapkan:

```
[server] Webhook siap di http://localhost:3000/webhook
[server] Health check: http://localhost:3000/health
```

## 4. Tes lokal

### a. Verifikasi GET (simulasi yang dilakukan Meta)

Buka di browser:

```
http://localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=sahabat_purchasing_rahasia_123&hub.challenge=987654321
```

Harus membalas teks `987654321` (HTTP 200). Jika token salah → `403 Forbidden`.

### b. POST dengan signature valid (cara termudah)

```powershell
npm run test:webhook                     # mengirim pesan teks "Halo"
node scripts/send-test-message.js Selamat pagi   # teks kustom
node scripts/send-test-message.js --bad-signature # harus ditolak 401
```

Console server akan menampilkan:

```
[wa] Pesan dari 6289876543210 (Budi): Halo
```

### c. POST dengan cURL (Windows — hitung HMAC memakai PowerShell)

```powershell
$body = '{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","contacts":[{"profile":{"name":"Siti"},"wa_id":"628111222333"}],"messages":[{"from":"628111222333","id":"wamid.X1","timestamp":"1700000000","type":"text","text":{"body":"Halo dari curl"}}]}}]}]}'
[IO.File]::WriteAllText("$env:TEMP\wa-body.json", $body, (New-Object Text.UTF8Encoding($false)))

$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes('app_secret_anda'))
$sig  = 'sha256=' + ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body))) -replace '-','').ToLower()

curl.exe -i -X POST http://localhost:3000/webhook `
  -H "Content-Type: application/json" `
  -H "X-Hub-Signature-256: $sig" `
  --data-binary "@$env:TEMP\wa-body.json"
```

Respons: `200 OK`. Tanpa header signature → `401`, signature salah → `401`.

### d. Postman

1. **GET** `http://localhost:3000/webhook`, tab **Params**, isi:
   - `hub.mode` = `subscribe`
   - `hub.verify_token` = `sahabat_purchasing_rahasia_123`
   - `hub.challenge` = `987654321`
2. **POST** `http://localhost:3000/webhook`, tab **Body → raw → JSON**, lalu:
   - **Headers**: `X-Hub-Signature-256` = `sha256=<hasil HMAC>` (Postman tidak menghitungnya otomatis; ambil dari output `npm run test:webhook` atau pakai script Node di atas).
   - **Settings → raw body**: pastikan Postman tidak mengubah body (jangan aktifkan "Pre-request Script" yang memodifikasi body), karena signature dihitung dari byte mentah.

> Catatan: signature dihitung dari **body mentah**, bukan objek JSON. Perubahan sekecil apa pun (spasi, urutan key) membuat signature tidak cocok.

## 5. Menghubungkan ke Meta

Meta membutuhkan URL publik **HTTPS**. Untuk uji lokal, pakai tunnel:

```powershell
ngrok http 3000
```

Lalu di **Meta App Dashboard → WhatsApp → Configuration**:

- **Callback URL**: `https://<subdomain-ngrok>/webhook`
- **Verify token**: `sahabat_purchasing_rahasia_123`
- Klik **Verify and save** → server akan menerima GET verifikasi.
- Setelah tersimpan, klik **Manage** pada Webhook fields dan centang `messages`.

Pastikan App Secret di `.env` sama dengan App Secret aplikasi tersebut, jika tidak semua POST akan ditolak `401`.

## 6. Keamanan yang sudah diterapkan

- Signature `X-Hub-Signature-256` = HMAC-SHA256(body mentah, App Secret), dibandingkan dengan `crypto.timingSafeEqual`.
- Token verifikasi & App Secret hanya dibaca dari environment, tidak ditulis di kode.
- Body dibatasi 1 MB dan hanya `application/json` yang diproses.
- POST dibalas `200` lebih dulu, lalu payload diproses, agar tidak kena timeout/retry Meta.

## 7. Troubleshooting

| Gejala | Penyebab umum |
| --- | --- |
| Klik *Verify and save* gagal di Meta | URL bukan HTTPS publik, atau `hub.verify_token` tidak sama dengan `WHATSAPP_VERIFY_TOKEN` |
| Semua POST dibalas `401` | `WHATSAPP_APP_SECRET` salah/kosong, atau body diubah oleh proxy/tool sebelum dikirim |
| `400` + log "Body bukan JSON valid" | Body bukan JSON, atau body termodifikasi (mis. oleh middleware lain) |
| Pesan tidak muncul di log | Field `messages` belum di-*subscribe* di dashboard Meta, atau `change.field` bukan `messages` |
