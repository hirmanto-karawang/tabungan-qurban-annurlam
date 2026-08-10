// ===== api/wa-status.js =====
// Cek status koneksi device WhatsApp (Fonnte) - dipakai buat badge
// "Terhubung/Terputus" di menu Broadcast WhatsApp, supaya admin tahu dari
// awal kalau device Fonnte-nya lagi disconnect (mis. HP mati/logout WA)
// sebelum capek-capek nulis pesan yang ujung-ujungnya gagal terkirim semua.
//
// Sama seperti wa-send.js, API key Fonnte cuma dipegang di server (env var
// FONNTE_API_KEY), tidak pernah dikirim ke browser.
//
// Endpoint:
//   GET /api/wa-status  -> { connected: true/false, device, name, quota, package, expired, error? }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method tidak didukung, pakai GET' });
    return;
  }

  try {
    const apiKey = process.env.FONNTE_API_KEY;
    if (!apiKey) {
      res.status(200).json({ connected: false, error: 'FONNTE_API_KEY belum diset di environment variables' });
      return;
    }

    const fonnteResp = await fetch('https://api.fonnte.com/device', {
      method: 'POST',
      headers: { Authorization: apiKey }
    });

    const data = await fonnteResp.json().catch(() => null);

    if (!fonnteResp.ok || !data || data.status === false) {
      res.status(200).json({ connected: false, error: (data && data.reason) || `HTTP ${fonnteResp.status}` });
      return;
    }

    res.status(200).json({
      connected: data.device_status === 'connect',
      deviceStatus: data.device_status,
      device: data.device,
      name: data.name,
      quota: data.quota,
      package: data.package,
      expired: data.expired
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ connected: false, error: err.message || String(err) });
  }
};
