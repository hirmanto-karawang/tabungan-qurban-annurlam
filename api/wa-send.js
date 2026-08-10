// ===== api/wa-send.js =====
// Proxy pengiriman WhatsApp lewat Fonnte. Ditambahkan supaya API key Fonnte
// TIDAK PERNAH tampil di kode sisi browser (sebelumnya hardcoded langsung di
// public/index.html - siapapun yang buka "View Page Source" bisa lihat dan
// pakai kuota WA masjid). Sekarang key-nya cuma ada di server, sebagai
// environment variable, persis seperti kredensial Google Sheets.
//
// ENV VAR yang wajib diisi di Vercel (Project Settings -> Environment Variables):
//   FONNTE_API_KEY   - token device dari https://fonnte.com (menu Device)
//
// Endpoint:
//   POST /api/wa-send   body: { "target": "08xxxxxxxxxx", "message": "isi pesan" }
//   -> { success: true, result: {...} }  atau  { success: false, error: ... }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method tidak didukung, pakai POST' });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      body = body ? JSON.parse(body) : {};
    }
    if (!body) body = {};

    const { target, message } = body;
    if (!target || !message) {
      res.status(400).json({ error: 'Parameter target dan message wajib diisi' });
      return;
    }

    const apiKey = process.env.FONNTE_API_KEY;
    if (!apiKey) {
      console.error('FONNTE_API_KEY belum diset di environment variables Vercel');
      res.status(500).json({ error: 'Server belum dikonfigurasi untuk kirim WhatsApp (FONNTE_API_KEY kosong)' });
      return;
    }

    const form = new URLSearchParams();
    form.append('target', String(target).trim());
    form.append('message', String(message));

    const fonnteResp = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    const result = await fonnteResp.json().catch(() => null);

    if (!fonnteResp.ok || (result && result.status === false)) {
      console.error('Fonnte menolak pengiriman:', target, result);
      res.status(200).json({ success: false, error: result || `HTTP ${fonnteResp.status}` });
      return;
    }

    res.status(200).json({ success: true, result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
};
