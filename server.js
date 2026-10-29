'use strict';

/**
 * Webhook receiver untuk WhatsApp Business Cloud API.
 *
 * Endpoint:
 *   GET  /webhook  -> verifikasi awal dari Meta (hub.mode / hub.verify_token / hub.challenge)
 *   POST /webhook  -> notifikasi pesan & status; wajib lolos validasi X-Hub-Signature-256
 *   GET  /health   -> health check sederhana
 */

const crypto = require('node:crypto');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';

if (!VERIFY_TOKEN || !APP_SECRET) {
  console.error('[config] WHATSAPP_VERIFY_TOKEN dan WHATSAPP_APP_SECRET wajib diisi (lihat .env.example).');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

// Simpan raw body: signature dihitung dari byte mentah request, bukan dari JSON hasil parse.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * Middleware validasi X-Hub-Signature-256.
 * Meta mengirim header berisi HMAC-SHA256(raw body, App Secret) dengan format "sha256=<hex>".
 */
function verifySignature(req, res, next) {
  const header = req.get('x-hub-signature-256');

  if (!header) {
    console.warn('[security] POST ditolak: header X-Hub-Signature-256 tidak ada.');
    return res.sendStatus(401);
  }

  const [algorithm, receivedHex] = header.split('=');
  if (algorithm !== 'sha256' || !receivedHex) {
    console.warn('[security] POST ditolak: format signature tidak dikenal.');
    return res.sendStatus(401);
  }

  const expected = crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody || Buffer.alloc(0))
    .digest();
  const received = Buffer.from(receivedHex, 'hex');

  // Bandingkan dengan timing-safe agar tidak bisa ditebak lewat timing attack.
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    console.warn('[security] POST ditolak: signature tidak cocok dengan App Secret.');
    return res.sendStatus(401);
  }

  return next();
}

// ---------------------------------------------------------------------------
// GET /webhook — Verification Request
// ---------------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[webhook] Verifikasi berhasil, mengirim hub.challenge ke Meta.');
    // Challenge harus dikembalikan apa adanya sebagai teks biasa (bukan JSON).
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }

  console.warn('[webhook] Verifikasi GAGAL: hub.mode atau hub.verify_token tidak sesuai.');
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// POST /webhook — Webhook Notifications
// ---------------------------------------------------------------------------
app.post('/webhook', verifySignature, (req, res) => {
  // Meta mengharuskan balasan 200 cepat (idealnya < 5 detik), jadi balas dulu lalu proses.
  res.sendStatus(200);

  try {
    processPayload(req.body);
  } catch (err) {
    console.error('[webhook] Gagal memproses payload:', err);
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

function processPayload(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account') {
    console.log('[webhook] Payload diabaikan: bukan event WhatsApp Business Account.');
    return;
  }

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') {
        console.log(`[webhook] Field "${change.field}" diabaikan (hanya "messages" yang diproses).`);
        continue;
      }

      const value = change.value || {};
      // Peta wa_id -> nama profil, agar log lebih mudah dibaca.
      const contacts = new Map((value.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));

      for (const message of value.messages || []) {
        logMessage(message, contacts);
      }
      for (const status of value.statuses || []) {
        logStatus(status);
      }
      for (const error of value.errors || []) {
        console.error('[wa:error]', JSON.stringify(error));
      }
    }
  }
}

function logMessage(message, contacts) {
  const from = message.from;
  const name = contacts.get(from) || 'tanpa nama';
  const prefix = `[wa] Pesan dari ${from} (${name})`;

  switch (message.type) {
    case 'text':
      console.log(`${prefix}: ${message.text && message.text.body}`);
      break;

    case 'button':
      console.log(`${prefix} [tombol] ${message.button && message.button.text} (payload: ${message.button && message.button.payload})`);
      break;

    case 'interactive': {
      const interactive = message.interactive || {};
      const reply = interactive.button_reply || interactive.list_reply || {};
      console.log(`${prefix} [interactive/${interactive.type}] ${reply.title} (id: ${reply.id})`);
      break;
    }

    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const media = message[message.type] || {};
      const caption = media.caption ? ` caption: "${media.caption}"` : '';
      console.log(`${prefix} [${message.type}] media id: ${media.id}${caption}`);
      break;
    }

    case 'location': {
      const location = message.location || {};
      console.log(`${prefix} [lokasi] ${location.latitude}, ${location.longitude}`);
      break;
    }

    case 'reaction':
      console.log(`${prefix} [reaksi] ${message.reaction && message.reaction.emoji}`);
      break;

    default:
      // Tipe lain (contacts, order, system, dsb.) dicetak apa adanya untuk inspeksi.
      console.log(`${prefix} [${message.type}]`, JSON.stringify(message));
  }
}

function logStatus(status) {
  const errorNote = status.errors && status.errors.length ? ` error: ${JSON.stringify(status.errors)}` : '';
  console.log(`[wa] Status pesan ${status.id} ke ${status.recipient_id}: ${status.status}${errorNote}`);
}

// Handler error terakhir: body bukan JSON valid / error tak terduga.
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    console.warn('[webhook] Body bukan JSON valid.');
    return res.sendStatus(400);
  }
  console.error('[server] Error tak terduga:', err);
  return res.sendStatus(500);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[server] Webhook siap di http://localhost:${PORT}/webhook`);
    console.log(`[server] Health check: http://localhost:${PORT}/health`);
  });
}

module.exports = app;
