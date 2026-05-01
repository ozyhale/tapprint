const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function openDb(databasePath) {
  const dir = path.dirname(databasePath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      original_filename TEXT NOT NULL,
      stored_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      gmail_message_id TEXT,
      gmail_attachment_id TEXT,
      sender_email TEXT,
      copies INTEGER NOT NULL DEFAULT 2,
      UNIQUE(gmail_message_id, gmail_attachment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

    CREATE TABLE IF NOT EXISTS print_idempotency (
      client_request_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  migrateJobsTable(db);

  return db;
}

function migrateJobsTable(db) {
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
  if (!cols.includes('copies')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN copies INTEGER NOT NULL DEFAULT 2`);
  }
}

module.exports = { openDb };
