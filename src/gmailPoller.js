const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

function sanitizeFilename(name) {
  return String(name || 'document.pdf').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200);
}

function collectPdfParts(part, acc) {
  if (!part) return;
  const mime = part.mimeType || '';
  const attachId = part.body && part.body.attachmentId;
  const filename = part.filename || '';
  if (mime === 'application/pdf' && attachId) {
    acc.push({
      attachmentId: attachId,
      filename: filename || 'attachment.pdf',
      size: Number(part.body.size || 0),
    });
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) collectPdfParts(p, acc);
  }
}

function headerFromPayload(payload, name) {
  const headers = payload && payload.headers;
  if (!headers) return '';
  const h = headers.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value || '') : '';
}

function loadGmailClient(config) {
  const { clientId, clientSecret, refreshToken } = config;
  if (!clientId || !clientSecret || !refreshToken) return null;

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function createPoller({ db, config, log }) {
  const gmail = loadGmailClient(config.gmail);
  let timer = null;
  let running = false;

  const insertJob = db.prepare(`
    INSERT INTO jobs (id, original_filename, stored_path, created_at, status, gmail_message_id, gmail_attachment_id, sender_email, copies)
    VALUES (@id, @original_filename, @stored_path, @created_at, @status, @gmail_message_id, @gmail_attachment_id, @sender_email, @copies)
  `);

  const jobExists = db.prepare(`
    SELECT 1 FROM jobs WHERE gmail_message_id = ? AND gmail_attachment_id = ? LIMIT 1
  `);

  async function pollOnce() {
    if (!gmail) return;
    if (running) return;
    running = true;
    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread has:attachment',
        maxResults: 15,
      });
      const msgs = listRes.data.messages || [];

      for (const m of msgs) {
        await processMessage(m.id);
      }
    } catch (e) {
      let extra = '';
      if (e.response && e.response.data) {
        try {
          extra = ` ${JSON.stringify(e.response.data)}`;
        } catch (_) {
          /* ignore */
        }
      }
      log.error(`Gmail poll error: ${e.message}${extra}`);
    } finally {
      running = false;
    }
  }

  async function processMessage(messageId) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const msg = full.data;
    const pdfParts = [];
    collectPdfParts(msg.payload, pdfParts);

    if (pdfParts.length === 0) {
      await markRead(messageId);
      return;
    }

    const maxBytes = config.maxPdfMb * 1024 * 1024;
    const sender = headerFromPayload(msg.payload, 'From');

    for (const part of pdfParts) {
      if (part.size && part.size > maxBytes) {
        log.warn(`Skipping large PDF (${part.size}b) on message ${messageId}`);
        continue;
      }

      const exists = jobExists.get(messageId, part.attachmentId);
      if (exists) continue;

      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: part.attachmentId,
      });

      const data = att.data.data.replace(/-/g, '+').replace(/_/g, '/');
      const buffer = Buffer.from(data, 'base64');

      if (buffer.length > maxBytes) {
        log.warn(`Skipping large PDF (${buffer.length}b) on message ${messageId}`);
        continue;
      }

      const id = crypto.randomUUID();
      const safeName = sanitizeFilename(part.filename);
      const storedName = `${id}_${safeName}`;
      const storedPath = path.join(config.jobsDir, storedName);

      fs.writeFileSync(storedPath, buffer);

      const now = Date.now();
      try {
        insertJob.run({
          id,
          original_filename: safeName,
          stored_path: storedPath,
          created_at: now,
          status: 'pending',
          gmail_message_id: messageId,
          gmail_attachment_id: part.attachmentId,
          sender_email: sender,
          copies: 1,
        });
        log.info(`Queued job ${id} (${safeName})`);
      } catch (e) {
        if (fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
        const code = e && e.code;
        if (code === 'SQLITE_CONSTRAINT_UNIQUE' || String(e.message || '').includes('UNIQUE')) {
          continue;
        }
        throw e;
      }
    }

    await markRead(messageId);
  }

  async function markRead(messageId) {
    try {
      await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (e) {
      log.warn(`Could not mark message ${messageId} read: ${e.message}`);
    }
  }

  function start() {
    if (!gmail) {
      log.warn('Gmail not configured (missing OAuth env). Poller disabled.');
      return;
    }
    const ms = Math.max(15, config.pollIntervalSeconds) * 1000;
    pollOnce().catch(() => {});
    timer = setInterval(() => {
      pollOnce().catch(() => {});
    }, ms);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, pollOnce };
}

module.exports = { createPoller };
