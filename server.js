/**
 * GD Insta Scheduler — backend Express per Umbrel OS
 *
 * Funzioni:
 * - SQLite: posts (bozza/programmato/pubblicato/errore), settings (token), logs
 * - Upload media (immagini/video) su /data/uploads
 * - Cron ogni minuto: pubblica i post programmati via Instagram Graph API
 * - API REST per il frontend + serving statico di /public
 *
 * Env:
 *   PORT (default 8757)
 *   DATA_DIR (default ./data, su Umbrel: /data)
 *   PUBLIC_URL (es. http://umbrel.local:8757) — serve a Meta per scaricare i media
 *   TZ (default Europe/Rome)
 *   IG_API_VERSION (default v21.0)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cron = require('node-cron');
const axios = require('axios');
require('dotenv').config();

const PORT = parseInt(process.env.PORT || '8757', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'scheduler.db');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const IG_API_VERSION = process.env.IG_API_VERSION || 'v21.0';
const IG_API = `https://graph.facebook.com/${IG_API_VERSION}`;

for (const d of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------- DB
const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caption TEXT NOT NULL DEFAULT '',
  media_paths TEXT NOT NULL DEFAULT '[]',
  media_type TEXT NOT NULL DEFAULT 'single',
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'bozza'
    CHECK (status IN ('bozza','programmato','pubblicato','errore','pubblicazione')),
  ig_container_id TEXT,
  ig_media_id TEXT,
  permalink TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_status_sched ON posts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_logs_post ON logs(post_id);
`);

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings(key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value == null ? '' : String(value));
}
function addLog(postId, level, message) {
  try {
    db.prepare('INSERT INTO logs(post_id, level, message) VALUES (?,?,?)')
      .run(postId || null, level, String(message).slice(0, 4000));
  } catch (e) {
    console.error('log failed', e.message);
  }
  console.log(`[${level}]${postId ? ' post#' + postId : ''} ${message}`);
}

// Settings di default (non sovrascrivono valori esistenti)
for (const [k, v] of [
  ['ig_user_id', process.env.IG_USER_ID || ''],
  ['access_token', process.env.IG_ACCESS_TOKEN || ''],
  ['app_secret', process.env.IG_APP_SECRET || ''],
  ['public_url', process.env.PUBLIC_URL || ''],
]) {
  if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k)) {
    setSetting(k, v);
  }
}

// ---------------------------------------------------------------- App
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Upload: immagini + video, max 10 file, 100MB cad.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`);
  },
});
function mediaFilter(_req, file, cb) {
  if (/^(image\/(jpeg|png|webp)|video\/mp4|video\/quicktime)/.test(file.mimetype)) cb(null, true);
  else cb(new Error('Tipo file non supportato (usa JPG/PNG/WebP/MP4)'));
}
const upload = multer({
  storage,
  fileFilter: mediaFilter,
  limits: { fileSize: 100 * 1024 * 1024, files: 10 },
});

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

const VALID_STATUS = new Set(['bozza', 'programmato', 'pubblicato', 'errore', 'pubblicazione']);
function rowToPost(r) {
  if (!r) return null;
  let media = [];
  try { media = JSON.parse(r.media_paths || '[]'); } catch { media = []; }
  return { ...r, media_paths: media };
}

// ------------------------------------------------------- Helpers IG
function igConfig() {
  const igUserId = getSetting('ig_user_id', '').trim();
  const accessToken = getSetting('access_token', '').trim();
  const publicUrl = (getSetting('public_url', '') || PUBLIC_URL).replace(/\/$/, '');
  return { igUserId, accessToken, publicUrl };
}

function mediaUrlFor(filename, publicUrl) {
  return `${publicUrl}/uploads/${encodeURIComponent(filename)}`;
}

function isVideoFile(filename) {
  return /\.(mp4|mov)$/i.test(filename);
}

/**
 * Crea un container media su IG.
 * @returns {Promise<string>} creation id
 */
async function igCreateContainer({ igUserId, accessToken, imageUrl, videoUrl, caption, isCarouselItem, mediaType }) {
  const params = { access_token: accessToken };
  if (isCarouselItem) {
    params.is_carousel_item = true;
  } else if (caption) {
    params.caption = caption;
  }
  if (videoUrl) {
    params.media_type = mediaType === 'REELS' ? 'REELS' : 'VIDEO';
    params.video_url = videoUrl;
  } else {
    if (!isCarouselItem && mediaType === 'CAROUSEL') {
      // mai qui: il carosello si crea dopo
    } else {
      params.image_url = imageUrl;
    }
    if (mediaType && !isCarouselItem) params.media_type = mediaType;
  }
  const { data } = await axios.post(`${IG_API}/${igUserId}/media`, null, { params, timeout: 30000 });
  if (!data || !data.id) throw new Error('IG non ha restituito un container id');
  return data.id;
}

async function igWaitContainerReady(containerId, accessToken, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const { data } = await axios.get(`${IG_API}/${containerId}`, {
      params: { fields: 'status_code', access_token: accessToken },
      timeout: 15000,
    });
    const code = (data && data.status_code) || 'UNKNOWN';
    if (code === 'FINISHED') return true;
    if (code === 'ERROR') throw new Error('IG: elaborazione media fallita (status_code=ERROR)');
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('IG: timeout attesa elaborazione media');
}

async function igPublishContainer({ igUserId, accessToken, creationId }) {
  const { data } = await axios.post(`${IG_API}/${igUserId}/media_publish`, null, {
    params: { creation_id: creationId, access_token: accessToken },
    timeout: 30000,
  });
  if (!data || !data.id) throw new Error('IG publish senza media id');
  return data.id;
}

async function igPermalink(igMediaId, accessToken) {
  try {
    const { data } = await axios.get(`${IG_API}/${igMediaId}`, {
      params: { fields: 'permalink', access_token: accessToken },
      timeout: 15000,
    });
    return data.permalink || null;
  } catch {
    return null;
  }
}

/**
 * Pubblica un post (single | carousel | video/reel).
 */
async function publishPost(postId) {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!row) throw new Error('Post non trovato');
  const post = rowToPost(row);
  const { igUserId, accessToken, publicUrl } = igConfig();
  if (!igUserId || !accessToken) throw new Error('Account Instagram non collegato (mancha IG User ID o Access Token)');
  if (!publicUrl) throw new Error('PUBLIC_URL non configurato: Meta deve poter scaricare i media via URL pubblico');
  if (!post.media_paths.length) throw new Error('Nessun media allegato');

  db.prepare(`UPDATE posts SET status='pubblicazione', error=NULL, updated_at=datetime('now') WHERE id=?`).run(postId);
  addLog(postId, 'info', `Avvio pubblicazione (${post.media_paths.length} media, tipo=${post.media_type})`);

  try {
    let creationId;
    if (post.media_paths.length > 1 || post.media_type === 'carousel') {
      // Carosello: un container per figlio, poi container CAROUSEL, poi publish
      const children = [];
      for (const f of post.media_paths) {
        const url = mediaUrlFor(f, publicUrl);
        const id = await igCreateContainer({
          igUserId, accessToken,
          imageUrl: isVideoFile(f) ? undefined : url,
          videoUrl: isVideoFile(f) ? url : undefined,
          isCarouselItem: true,
        });
        children.push(id);
        if (isVideoFile(f)) await igWaitContainerReady(id, accessToken);
      }
      const { data } = await axios.post(`${IG_API}/${igUserId}/media`, null, {
        params: {
          media_type: 'CAROUSEL',
          children: children.join(','),
          caption: post.caption || undefined,
          access_token: accessToken,
        },
        timeout: 30000,
      });
      creationId = data.id;
      await igWaitContainerReady(creationId, accessToken);
    } else {
      const f = post.media_paths[0];
      const url = mediaUrlFor(f, publicUrl);
      const isVideo = isVideoFile(f);
      creationId = await igCreateContainer({
        igUserId, accessToken,
        imageUrl: isVideo ? undefined : url,
        videoUrl: isVideo ? url : undefined,
        caption: post.caption || undefined,
        mediaType: post.media_type === 'reel' ? 'REELS' : undefined,
      });
      if (isVideo) await igWaitContainerReady(creationId, accessToken);
    }

    const igMediaId = await igPublishContainer({ igUserId, accessToken, creationId });
    const permalink = await igPermalink(igMediaId, accessToken);
    db.prepare(`UPDATE posts SET status='pubblicato', ig_container_id=?, ig_media_id=?, permalink=?, error=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(creationId, igMediaId, permalink, postId);
    addLog(postId, 'success', `Pubblicato su Instagram (media_id=${igMediaId})${permalink ? ' ' + permalink : ''}`);
    return { igMediaId, permalink };
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message || 'Errore sconosciuto';
    db.prepare(`UPDATE posts SET status='errore', error=?, updated_at=datetime('now') WHERE id=?`).run(String(msg).slice(0, 2000), postId);
    addLog(postId, 'error', `Pubblicazione fallita: ${msg}`);
    throw new Error(msg);
  }
}

// ------------------------------------------------------------ API
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: '1.0.0', time: new Date().toISOString(), dataDir: DATA_DIR });
});

app.get('/api/settings', (_req, res) => {
  const accessToken = getSetting('access_token', '');
  res.json({
    ig_user_id: getSetting('ig_user_id', ''),
    access_token_masked: accessToken ? `***${accessToken.slice(-4)}` : '',
    has_token: !!accessToken,
    app_secret_set: !!getSetting('app_secret', ''),
    public_url: getSetting('public_url', '') || PUBLIC_URL,
  });
});

app.post('/api/settings', (req, res) => {
  const { ig_user_id, access_token, app_secret, public_url } = req.body || {};
  if (ig_user_id !== undefined) setSetting('ig_user_id', String(ig_user_id).trim());
  if (access_token !== undefined && String(access_token).trim() && !String(access_token).startsWith('***')) {
    setSetting('access_token', String(access_token).trim());
  }
  if (app_secret !== undefined) setSetting('app_secret', String(app_secret).trim());
  if (public_url !== undefined) setSetting('public_url', String(public_url).trim().replace(/\/$/, ''));
  addLog(null, 'info', 'Impostazioni aggiornate');
  res.json({ ok: true });
});

app.post('/api/connect/test', async (_req, res) => {
  const { igUserId, accessToken } = igConfig();
  if (!igUserId || !accessToken) return res.status(400).json({ ok: false, error: 'IG User ID o Access Token mancanti' });
  try {
    const { data } = await axios.get(`${IG_API}/${igUserId}`, {
      params: { fields: 'id,username,account_type,media_count', access_token: accessToken },
      timeout: 15000,
    });
    addLog(null, 'success', `Test connessione OK (@${data.username})`);
    res.json({ ok: true, account: data });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    addLog(null, 'error', `Test connessione fallito: ${msg}`);
    res.status(502).json({ ok: false, error: msg });
  }
});

// Lista post
app.get('/api/posts', (req, res) => {
  const { status } = req.query;
  let rows;
  if (status && VALID_STATUS.has(String(status))) {
    rows = db.prepare('SELECT * FROM posts WHERE status = ? ORDER BY scheduled_at IS NULL, scheduled_at ASC, id DESC').all(String(status));
  } else {
    rows = db.prepare('SELECT * FROM posts ORDER BY scheduled_at IS NULL, scheduled_at ASC, id DESC').all();
  }
  res.json(rows.map(rowToPost));
});

// Crea post (multipart: files[] + caption + scheduled_at + media_type)
app.post('/api/posts', upload.array('files', 10), (req, res) => {
  try {
    const caption = String(req.body.caption || '').slice(0, 2200);
    const scheduledAt = req.body.scheduled_at ? String(req.body.scheduled_at) : null;
    let mediaType = String(req.body.media_type || 'single');
    if (!['single', 'carousel', 'reel'].includes(mediaType)) mediaType = 'single';
    const files = (req.files || []).map((f) => path.basename(f.filename));
    let existing = [];
    try { existing = JSON.parse(req.body.existing_media || '[]'); } catch { existing = []; }
    const media = [...existing, ...files].slice(0, 10);
    if (!media.length) return res.status(400).json({ ok: false, error: 'Carica almeno un media' });

    let status = 'bozza';
    if (scheduledAt) {
      const d = new Date(scheduledAt);
      if (isNaN(d.getTime())) return res.status(400).json({ ok: false, error: 'Data/ora non valida' });
      status = d.getTime() > Date.now() ? 'programmato' : 'bozza';
    }
    if (media.length > 1 && mediaType === 'single') mediaType = 'carousel';
    const info = db.prepare(
      `INSERT INTO posts(caption, media_paths, media_type, scheduled_at, status) VALUES (?,?,?,?,?)`
    ).run(caption, JSON.stringify(media), mediaType, scheduledAt, status);
    const created = rowToPost(db.prepare('SELECT * FROM posts WHERE id=?').get(info.lastInsertRowid));
    addLog(created.id, 'info', `Post creato (${media.length} media, stato=${status})`);
    res.status(201).json({ ok: true, post: created });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Non trovato' });
  res.json({ ok: true, post: rowToPost(row) });
});

app.patch('/api/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Non trovato' });
  const { caption, scheduled_at, status, media_type } = req.body || {};
  const patch = rowToPost(row);
  if (caption !== undefined) patch.caption = String(caption).slice(0, 2200);
  if (media_type !== undefined && ['single', 'carousel', 'reel'].includes(media_type)) patch.media_type = media_type;
  if (scheduled_at !== undefined) patch.scheduled_at = scheduled_at ? String(scheduled_at) : null;
  if (status !== undefined) {
    if (!VALID_STATUS.has(status)) return res.status(400).json({ ok: false, error: 'Stato non valido' });
    if (['pubblicato', 'pubblicazione'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Non puoi impostare manualmente questo stato' });
    }
    patch.status = status;
    if (status === 'bozza') patch.error = null;
  }
  // Se riprogrammato nel futuro e in bozza/errore -> programmato
  if (patch.scheduled_at && ['bozza', 'errore'].includes(patch.status)) {
    if (new Date(patch.scheduled_at).getTime() > Date.now()) patch.status = 'programmato';
  }
  db.prepare(`UPDATE posts SET caption=?, scheduled_at=?, status=?, media_type=?, error=?, updated_at=datetime('now') WHERE id=?`)
    .run(patch.caption, patch.scheduled_at, patch.status, patch.media_type, patch.error || null, req.params.id);
  addLog(Number(req.params.id), 'info', `Post aggiornato (stato=${patch.status})`);
  res.json({ ok: true, post: rowToPost(db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id)) });
});

app.delete('/api/posts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Non trovato' });
  const post = rowToPost(row);
  for (const f of post.media_paths) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(f))); } catch { /* ignora */ }
  }
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  addLog(Number(req.params.id), 'info', 'Post eliminato');
  res.json({ ok: true });
});

app.post('/api/posts/:id/publish-now', async (req, res) => {
  try {
    const r = await publishPost(Number(req.params.id));
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post('/api/posts/:id/retry', async (req, res) => {
  db.prepare(`UPDATE posts SET status='programmato', error=NULL WHERE id=? AND status='errore'`).run(req.params.id);
  try {
    const r = await publishPost(Number(req.params.id));
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  const rows = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

// Fallback SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------------------------------------------------ Cron
// Ogni minuto: pubblica i post programmati scaduti.
cron.schedule('* * * * *', async () => {
  try {
    const due = db.prepare(
      `SELECT * FROM posts WHERE status='programmato' AND scheduled_at IS NOT NULL
       AND datetime(scheduled_at) <= datetime('now') ORDER BY scheduled_at ASC LIMIT 5`
    ).all();
    for (const r of due) {
      try {
        await publishPost(r.id);
      } catch (e) {
        console.error(`post#${r.id} fallito:`, e.message);
      }
    }
    // Token long-lived: prova refresh 1 volta al giorno (se token presente)
    const { accessToken } = igConfig();
    if (accessToken && new Date().getHours() === 3 && new Date().getMinutes() < 2) {
      try {
        const { data } = await axios.get('https://graph.facebook.com/oauth/access_token', {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: getSetting('app_id', '') || undefined,
            client_secret: getSetting('app_secret', '') || undefined,
            fb_exchange_token: accessToken,
          },
          timeout: 15000,
        });
        if (data && data.access_token) {
          setSetting('access_token', data.access_token);
          addLog(null, 'info', 'Access token rinnovato automaticamente');
        }
      } catch { /* silenzioso: refresh manuale dalle impostazioni */ }
    }
  } catch (e) {
    console.error('cron error', e.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GD Insta Scheduler in ascolto su :${PORT} (DATA_DIR=${DATA_DIR})`);
});
