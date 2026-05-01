require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

const { openDb } = require('./db');
const { printPdf } = require('./printWindows');
const { createPoller } = require('./gmailPoller');

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig() {
  const jobsDir = path.resolve(process.cwd(), process.env.JOBS_DIR || './jobs');
  const databasePath = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/tapprint.db');

  return {
    port: envInt('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    sessionSecret: process.env.SESSION_SECRET || 'dev-change-me',
    operatorPin: process.env.OPERATOR_PIN || '1234',
    jobsDir,
    databasePath,
    pollIntervalSeconds: envInt('POLL_INTERVAL_SECONDS', 45),
    maxPdfMb: envInt('MAX_PDF_MB', 25),
    sumatraPath: process.env.SUMATRA_PATH || 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe',
    printerBw: process.env.PRINTER_BW || 'ReceiptPrinter_BW',
    printerColor: process.env.PRINTER_COLOR || 'ReceiptPrinter_Color',
    gmail: {
      clientId: String(process.env.GOOGLE_CLIENT_ID || '').trim(),
      clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || '').trim(),
      refreshToken: String(process.env.GOOGLE_REFRESH_TOKEN || '').trim(),
    },
  };
}

function logFactory() {
  return {
    info: (m) => console.log(`[tapprint] ${m}`),
    warn: (m) => console.warn(`[tapprint] ${m}`),
    error: (m) => console.error(`[tapprint] ${m}`),
  };
}

function pinMatches(provided, expected) {
  const hash = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();
  try {
    return crypto.timingSafeEqual(hash(provided), hash(expected));
  } catch {
    return false;
  }
}

function main() {
  const config = loadConfig();
  const log = logFactory();

  fs.mkdirSync(config.jobsDir, { recursive: true });

  const db = openDb(config.databasePath);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.use(
    session({
      name: 'tapprint.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );

  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated === true) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }

  app.post('/login', (req, res) => {
    const pin = req.body && req.body.pin;
    if (pinMatches(pin || '', config.operatorPin)) {
      req.session.authenticated = true;
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'Invalid PIN' });
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ ok: true, name: 'TapPrint' });
  });

  app.get('/api/jobs', requireAuth, (req, res) => {
    const rows = db
      .prepare(
        `SELECT id, original_filename AS filename, copies AS copies_default, created_at, sender_email
         FROM jobs WHERE status = 'pending' ORDER BY created_at ASC`
      )
      .all();
    res.json({ jobs: rows });
  });

  app.patch('/api/jobs/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const copies = req.body && req.body.copies;
    const n = parseInt(copies, 10);
    if (!Number.isFinite(n) || n < 1 || n > 99) {
      return res.status(400).json({ error: 'copies must be 1-99' });
    }
    const info = db.prepare(`UPDATE jobs SET copies = ? WHERE id = ? AND status = 'pending'`).run(n, id);
    if (info.changes === 0) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true, id, copies: n });
  });

  const getIdempotent = db.prepare(`SELECT response_json FROM print_idempotency WHERE client_request_id = ?`);
  const putIdempotent = db.prepare(
    `INSERT INTO print_idempotency (client_request_id, job_id, response_json, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const getJob = db.prepare(`SELECT * FROM jobs WHERE id = ? AND status = 'pending'`);
  const deleteJob = db.prepare(`DELETE FROM jobs WHERE id = ?`);

  app.post('/api/jobs/:id/print', requireAuth, async (req, res) => {
    const { id } = req.params;
    const mode = req.body && req.body.mode;
    const copies = req.body && req.body.copies;
    const clientRequestId = req.body && req.body.client_request_id;

    if (!clientRequestId || typeof clientRequestId !== 'string') {
      return res.status(400).json({ error: 'client_request_id required' });
    }

    const cached = getIdempotent.get(clientRequestId);
    if (cached) {
      try {
        return res.json(JSON.parse(cached.response_json));
      } catch {
        return res.status(500).json({ error: 'Bad cache' });
      }
    }

    const printerName = mode === 'color' ? config.printerColor : config.printerBw;
    if (mode !== 'bw' && mode !== 'color') {
      return res.status(400).json({ error: 'mode must be bw or color' });
    }

    const job = getJob.get(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const copiesN = copies !== undefined ? parseInt(copies, 10) : job.copies;
    if (!Number.isFinite(copiesN) || copiesN < 1 || copiesN > 99) {
      return res.status(400).json({ error: 'copies must be 1-99' });
    }

    let receipt;
    try {
      await printPdf({
        sumatraPath: config.sumatraPath,
        printerName,
        pdfPath: job.stored_path,
        copies: copiesN,
      });
      receipt = {
        ok: true,
        receipt_id: crypto.randomUUID(),
        job_id: id,
        mode,
        copies: copiesN,
        printer: printerName,
      };
    } catch (e) {
      log.error(`Print failed: ${e.message}`);
      return res.status(500).json({ error: e.message || 'Print failed' });
    }

    try {
      putIdempotent.run(clientRequestId, id, JSON.stringify(receipt), Date.now());
    } catch (e) {
      const again = getIdempotent.get(clientRequestId);
      if (again) return res.json(JSON.parse(again.response_json));
      throw e;
    }

    try {
      if (fs.existsSync(job.stored_path)) fs.unlinkSync(job.stored_path);
    } catch (e) {
      log.warn(`Could not delete file ${job.stored_path}: ${e.message}`);
    }
    deleteJob.run(id);

    return res.json(receipt);
  });

  app.delete('/api/jobs/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const job = getJob.get(id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    try {
      if (fs.existsSync(job.stored_path)) fs.unlinkSync(job.stored_path);
    } catch (e) {
      log.warn(`Could not delete file ${job.stored_path}: ${e.message}`);
    }
    deleteJob.run(id);
    res.json({ ok: true, id });
  });

  const poller = createPoller({
    db,
    config: {
      gmail: config.gmail,
      jobsDir: config.jobsDir,
      pollIntervalSeconds: config.pollIntervalSeconds,
      maxPdfMb: config.maxPdfMb,
    },
    log,
  });

  poller.start();

  app.listen(config.port, config.host, () => {
    log.info(`TapPrint listening on http://${config.host}:${config.port}`);
  });
}

main();
