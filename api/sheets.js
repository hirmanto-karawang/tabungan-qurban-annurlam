// ===== api/sheets.js =====
// Pengganti Google Apps Script. Berjalan sebagai Vercel Serverless Function,
// jauh lebih cepat karena tidak ada overhead "buka Spreadsheet dari nol" ala
// Apps Script, dan tidak perlu redirect ke script.googleusercontent.com.
//
// Autentikasi pakai OAuth refresh token (bukan service account key, karena
// organization policy Google Cloud memblokir pembuatan service account key).
// Ini bertindak sebagai akun Google pemilik Sheet, jadi otomatis punya akses
// edit tanpa perlu "share" sheet ke siapapun.
//
// ENV VARS yang wajib diisi di Vercel (Project Settings -> Environment Variables):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   GOOGLE_SHEET_ID     - ID Google Sheet (lihat panduan setup: bagian antara
//                         /d/ dan /edit di URL spreadsheet Anda)
//
// Endpoint & format request/response SENGAJA dibuat sama persis dengan Apps
// Script lama, supaya frontend cuma perlu ganti SHEETDB_CONFIG.ENDPOINT:
//   GET  /api/sheets                          -> { status: 'API is running' }
//   GET  /api/sheets?sheet=Members             -> array of objects
//   GET  /api/sheets?bootstrap=1               -> { Members:[], Savings:[], Verifications:[], Pesan:[], Pendaftaran:[], Templates:[], LoginLog:[] }
//   GET  /api/sheets?sheet=Savings&getFile=<id> -> { id, fileData }
//   POST /api/sheets?sheet=Members&action=append  body: JSON record
//   POST /api/sheets?sheet=Members&action=update  body: { keyColumn, keyValue, updates }

// Fallback ke ID spreadsheet Masjid Dhafinul Jariyah kalau env var belum
// diset, supaya deployment yang sudah jalan tidak tiba-tiba rusak. Masjid/DKM
// lain yang deploy ulang project ini WAJIB set GOOGLE_SHEET_ID di Vercel ke
// ID spreadsheet mereka sendiri - jangan pakai ID di bawah ini.
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1UareCU-UMZianvrCKWVeI7_LHZlOgEAOlBJfBwjcH4Q';
const SHEET_NAMES = ['Members', 'Savings', 'Verifications', 'Pesan', 'Pendaftaran', 'Templates', 'LoginLog'];

// ----- Cache access token di memori (bertahan selama instance function masih "warm") -----
let cachedAccessToken = null;
let accessTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt - 60000) {
    return cachedAccessToken;
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token'
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error('Gagal refresh access token: ' + errText);
  }

  const data = await resp.json();
  cachedAccessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return cachedAccessToken;
}

// ----- Cache hasil bootstrap di memori, TTL pendek (mirip CacheService di Apps Script) -----
let bootstrapCache = null;
let bootstrapCacheAt = 0;
const BOOTSTRAP_TTL_MS = 12000;

function invalidateBootstrapCache() {
  bootstrapCache = null;
}

// ----- Helper: panggil Google Sheets API v4 -----
async function sheetsFetch(path, accessToken, options = {}) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Sheets API error (${resp.status}): ${errText}`);
  }
  return resp.json();
}

// Konversi array 2D (values dari Sheets API) jadi array of objects pakai baris pertama sebagai header
function valuesToObjects(values) {
  if (!values || values.length === 0) return [];
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[i][idx] !== undefined ? values[i][idx] : ''; });
    rows.push(row);
  }
  return rows;
}

function columnToLetter(colIndexZeroBased) {
  let letter = '';
  let col = colIndexZeroBased + 1;
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// Baca 1 sheet penuh -> array of objects. Untuk Savings, fileData (base64 foto
// bukti, bisa besar) DIBUANG dan diganti flag hasFile - sama seperti versi
// Apps Script sebelumnya, supaya list/bootstrap tetap ringan & cepat.
async function readSheet(sheetName, accessToken) {
  const data = await sheetsFetch(`/values/${encodeURIComponent(sheetName)}`, accessToken);
  let rows = valuesToObjects(data.values || []);
  if (sheetName === 'Savings') {
    rows = rows.map(row => {
      const hasFile = !!row.fileData;
      return { ...row, fileData: '', hasFile };
    });
  }
  return rows;
}

async function readAllSheetsBatch(accessToken) {
  try {
    const rangesQuery = SHEET_NAMES.map(n => `ranges=${encodeURIComponent(n)}`).join('&');
    const data = await sheetsFetch(`/values:batchGet?${rangesQuery}`, accessToken);
    const result = {};
    SHEET_NAMES.forEach((name, idx) => {
      const valueRange = data.valueRanges[idx];
      let rows = valuesToObjects(valueRange.values || []);
      if (name === 'Savings') {
        rows = rows.map(row => {
          const hasFile = !!row.fileData;
          return { ...row, fileData: '', hasFile };
        });
      }
      result[name] = rows;
    });
    return result;
  } catch (err) {
    // Kalau salah satu sheet di SHEET_NAMES belum ada (mis. sheet "Templates"
    // belum dibuat user), Google Sheets API menolak SELURUH request batchGet
    // (bukan cuma range yang bermasalah) -> tanpa fallback ini, satu sheet
    // yang belum ada bisa bikin SEMUA data (Members, Savings, dst) gagal
    // dimuat. Jadi kalau batch gagal, coba baca satu-satu; yang error
    // (sheet belum ada) cukup dianggap kosong, bukan bikin semuanya gagal.
    console.error('batchGet gagal, fallback ke baca per-sheet:', err.message);
    const result = {};
    await Promise.all(SHEET_NAMES.map(async (name) => {
      try {
        result[name] = await readSheet(name, accessToken);
      } catch (innerErr) {
        console.error(`Sheet "${name}" gagal dibaca (mungkin belum dibuat):`, innerErr.message);
        result[name] = [];
      }
    }));
    return result;
  }
}

async function appendRow(sheetName, record, accessToken) {
  // Ambil header dulu buat tahu urutan kolom
  const headerData = await sheetsFetch(`/values/${encodeURIComponent(sheetName)}!1:1`, accessToken);
  const headers = (headerData.values && headerData.values[0]) || [];
  const newRow = headers.map(h => (record[h] !== undefined ? record[h] : ''));

  // valueInputOption=RAW penting: supaya nilai seperti "0812..." TIDAK diubah
  // jadi angka (dan kehilangan 0 di depan) oleh Google Sheets.
  await sheetsFetch(
    `/values/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ values: [newRow] }) }
  );
}

async function updateRows(sheetName, keyColumn, keyValue, updates, accessToken) {
  const data = await sheetsFetch(`/values/${encodeURIComponent(sheetName)}`, accessToken);
  const values = data.values || [];
  if (values.length === 0) return { success: false, updated: 0 };

  const headers = values[0];
  const keyColIndex = headers.indexOf(keyColumn);
  if (keyColIndex === -1) return { success: false, updated: 0, error: `Kolom ${keyColumn} tidak ditemukan` };

  const lastColLetter = columnToLetter(headers.length - 1);
  const batchData = [];
  let updatedCount = 0;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][keyColIndex] || '') === String(keyValue)) {
      const rowCopy = headers.map((h, idx) => (values[i][idx] !== undefined ? values[i][idx] : ''));
      for (const key in updates) {
        const colIdx = headers.indexOf(key);
        if (colIdx !== -1) rowCopy[colIdx] = updates[key];
      }
      const rowNumber = i + 1; // 1-indexed, +1 lagi karena header di baris 1
      batchData.push({
        range: `${sheetName}!A${rowNumber}:${lastColLetter}${rowNumber}`,
        values: [rowCopy]
      });
      updatedCount++;
    }
  }

  if (updatedCount === 0) return { success: false, updated: 0 };

  await sheetsFetch(`/values:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'RAW', data: batchData })
  });

  return { success: true, updated: updatedCount };
}

async function getFileData(savingsId, accessToken) {
  const data = await sheetsFetch(`/values/${encodeURIComponent('Savings')}`, accessToken);
  const values = data.values || [];
  if (values.length === 0) return '';
  const headers = values[0];
  const idCol = headers.indexOf('id');
  const fileCol = headers.indexOf('fileData');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol] || '') === String(savingsId)) {
      return values[i][fileCol] || '';
    }
  }
  return '';
}

// ----- Handler utama -----
export default async function handler(req, res) {
  // Same-origin (frontend & API di domain Vercel yang sama), tapi tambahkan
  // CORS permisif juga buat jaga-jaga/testing dari domain lain.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const accessToken = await getAccessToken();
    const { sheet, bootstrap, getFile, action } = req.query;

    if (req.method === 'GET') {
      if (sheet === 'Savings' && getFile) {
        const fileData = await getFileData(getFile, accessToken);
        return res.status(200).json({ id: getFile, fileData });
      }

      if (bootstrap) {
        if (bootstrapCache && (Date.now() - bootstrapCacheAt) < BOOTSTRAP_TTL_MS) {
          return res.status(200).json(bootstrapCache);
        }
        const data = await readAllSheetsBatch(accessToken);
        bootstrapCache = data;
        bootstrapCacheAt = Date.now();
        return res.status(200).json(data);
      }

      if (!sheet) {
        return res.status(200).json({ status: 'API is running', timestamp: new Date(), debugSheetId: SHEET_ID, debugEnvSet: !!process.env.GOOGLE_SHEET_ID });
      }

      const rows = await readSheet(sheet, accessToken);
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      if (!sheet) {
        return res.status(400).json({ error: 'Parameter sheet wajib diisi, contoh: ?sheet=Members' });
      }

      let body = req.body;
      if (typeof body === 'string') {
        body = body ? JSON.parse(body) : {};
      }
      if (!body) body = {};

      invalidateBootstrapCache();

      if (action === 'update') {
        const { keyColumn, keyValue, updates } = body;
        const result = await updateRows(sheet, keyColumn, keyValue, updates || {}, accessToken);
        return res.status(200).json(result);
      } else {
        await appendRow(sheet, body, accessToken);
        return res.status(200).json({ success: true, created: true });
      }
    }

    res.status(405).json({ error: 'Method tidak didukung' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
