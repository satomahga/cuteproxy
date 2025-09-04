import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { migrateDatabase } from "../src/shared/database";
import { config } from "../src/config";

function usage() {
  console.log(`Usage:\n  ts-node scripts/seed-abuse-events.ts <token> <mode>\n\nModes:\n  continuous14h  -> one event per hour for the last 14 hours (triggers 14h temporary suspension rule)\n  flex24h        -> chain of events ≤ 2h apart spanning 24h (triggers 24h continuous rule)\n  ip-spike       -> multiple events within the last 10 minutes from 4+ unique IPs (triggers IP spike rule)\n  bulk149        -> seeds exactly 149 events spaced ~1s apart (utility for testing request counters)\n`);
}

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ensureDb(): Database.Database {
  const dbPath = config.sqliteDataPath!;
  ensureDir(dbPath);
  const db = new Database(dbPath);
  try {
    migrateDatabase(undefined, db);
  } catch (_) {}
  db.exec(`CREATE TABLE IF NOT EXISTS events
    (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        type         TEXT    NOT NULL,
        ip           TEXT    NOT NULL,
        date         TEXT    NOT NULL,
        model        TEXT    NOT NULL,
        family       TEXT    NOT NULL,
        hashes       TEXT    NOT NULL,
        userToken    TEXT    NOT NULL,
        inputTokens  INTEGER NOT NULL,
        outputTokens INTEGER NOT NULL
    )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_userToken ON events (userToken);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_ip ON events (ip);`);
  return db;
}

function ensureUserStoreDb(): Database.Database | undefined {
  const userDbPath = config.sqliteUserStorePath;
  if (!userDbPath) return undefined;
  ensureDir(userDbPath);
  const udb = new Database(userDbPath);
  udb.pragma('journal_mode = WAL');
  udb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      token TEXT PRIMARY KEY,
      ip TEXT,
      nickname TEXT,
      type TEXT NOT NULL CHECK(type IN ('normal', 'special', 'temporary', 'subscription')),
      tier TEXT,
      promptCount INTEGER NOT NULL DEFAULT 0,
      tokenCounts TEXT,
      tokenLimits TEXT,
      tokenRefresh TEXT,
      createdAt INTEGER NOT NULL,
      lastUsedAt INTEGER,
      disabledAt INTEGER,
      disabledReason TEXT,
      expiresAt INTEGER,
      maxIps INTEGER,
      adminNote TEXT,
      meta TEXT
    );
  `);
  return udb;
}

function incrementUserPromptCount(udb: Database.Database, token: string, delta: number) {
  const getStmt = udb.prepare('SELECT promptCount FROM users WHERE token = ?');
  const row = getStmt.get(token) as { promptCount?: number } | undefined;
  if (!row) {
    console.warn(`User ${token} not found in user-store DB; cannot increment promptCount.`);
    return false;
  }
  const upd = udb.prepare('UPDATE users SET promptCount = promptCount + ?, lastUsedAt = ? WHERE token = ?');
  upd.run(delta, Date.now(), token);
  return true;
}

function updateUserMetaPromptCount(udb: Database.Database, token: string, service: string, delta: number) {
  const row = udb.prepare('SELECT meta FROM users WHERE token = ?').get(token) as { meta?: string } | undefined;
  if (!row) {
    console.warn(`User ${token} not found in user-store DB; cannot update meta.`);
    return false;
  }
  let meta: any = {};
  try { meta = row.meta ? JSON.parse(row.meta) : {}; } catch { meta = {}; }
  const promptCounts = (meta.promptCounts && typeof meta.promptCounts === 'object') ? meta.promptCounts : {};
  promptCounts[service] = (Number(promptCounts[service]) || 0) + delta;
  meta.promptCounts = promptCounts;
  const upd = udb.prepare('UPDATE users SET meta = ?, lastUsedAt = ? WHERE token = ?');
  upd.run(JSON.stringify(meta), Date.now(), token);
  return true;
}

function insertEvent(db: Database.Database, opts: {
  token: string;
  ip: string;
  date: string; // ISO string
}) {
  const stmt = db.prepare(
    `INSERT INTO events(type, ip, date, model, family, hashes, userToken, inputTokens, outputTokens)
     VALUES (@type, @ip, @date, @model, @family, @hashes, @userToken, @inputTokens, @outputTokens)`
  );
  stmt.run({
    type: "chat_completion",
    ip: opts.ip,
    date: opts.date,
    model: "test-model",
    family: "test-family",
    hashes: "dummy",
    userToken: opts.token,
    inputTokens: 1,
    outputTokens: 1,
  });
}

function countEvents(db: Database.Database, token: string) {
  const row = db.prepare(`SELECT COUNT(*) as c FROM events WHERE userToken = ?`).get(token) as { c: number };
  return row?.c || 0;
}

function seedContinuous14h(db: Database.Database, token: string) {
  const now = Date.now();
  const trx = db.transaction(() => {
    for (let i = 14; i > 0; i--) {
      const ts = new Date(now - i * 60 * 60 * 1000 + 3 * 60 * 1000).toISOString();
      insertEvent(db, { token, ip: "203.0.113.2", date: ts });
    }
  });
  trx();
  console.log("Seeded 14 hourly events for temporary suspension test.");
}

function seedFlex24h(db: Database.Database, token: string) {
  const now = Date.now();
  const intervalMs = 90 * 60 * 1000;
  const intervals = 16;
  const trx = db.transaction(() => {
    for (let i = intervals; i >= 0; i--) {
      const ts = new Date(now - i * intervalMs).toISOString();
      insertEvent(db, { token, ip: "203.0.113.3", date: ts });
    }
  });
  trx();
  console.log("Seeded 24h chain with <=2h gaps for permanent flex rule test.");
}

function seedIpSpike(db: Database.Database, token: string) {
  const base = Date.now() - 8 * 60 * 1000; // within 10 minutes
  const ips = [
    "198.51.100.10",
    "203.0.113.20",
    "192.0.2.30",
    "2001:db8:1::1",
    "2001:db8:2::2",
  ];
  const trx = db.transaction(() => {
    for (let i = 0; i < 4; i++) {
      const ts = new Date(base + i * 60 * 1000).toISOString();
      insertEvent(db, { token, ip: ips[i], date: ts });
    }
  });
  trx();
  console.log("Seeded events from 4 unique IPs within last 10 minutes.");
}

function seedBulk149(db: Database.Database, token: string) {
  const base = Date.now() - 149 * 1000; // ~1s spacing back from now
  const ip = "203.0.113.149";
  const trx = db.transaction(() => {
    for (let i = 0; i < 149; i++) {
      const ts = new Date(base + i * 1000).toISOString();
      insertEvent(db, { token, ip, date: ts });
    }
  });
  trx();
  console.log("Seeded 149 events spaced ~1s apart.");
}

import http from 'http';
import https from 'https';
import { URL } from 'url';

function parseArgFlag(name: string): string | undefined {
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function requestJson(method: string, urlStr: string, headers: Record<string, string>, body?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const opts: any = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ''),
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };
    const req = (isHttps ? https : http).request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(txt ? JSON.parse(txt) : {}); } catch { resolve({}); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${txt}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function adminUpdatePromptAndMeta(adminUrl: string, adminKey: string, token: string, delta: number, service: string) {
  try {
    const base = adminUrl.replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${adminKey}` } as Record<string, string>;
    const user = await requestJson('GET', `${base}/admin/users/${encodeURIComponent(token)}`, headers);
    const newCount = (Number(user.promptCount) || 0) + delta;
    const currentMeta = (user.meta && typeof user.meta === 'object') ? user.meta : {};
    const currentPromptCounts = (currentMeta.promptCounts && typeof currentMeta.promptCounts === 'object') ? currentMeta.promptCounts : {};
    const newServiceCount = (Number(currentPromptCounts[service]) || 0) + delta;
    const newMeta = { ...currentMeta, promptCounts: { ...currentPromptCounts, [service]: newServiceCount } };
    await requestJson('PUT', `${base}/admin/users/${encodeURIComponent(token)}`, headers, { promptCount: newCount, meta: newMeta });
    console.log(`Admin API: set promptCount=${newCount}, meta.promptCounts['${service}']=${newServiceCount} for ${token}`);
    return true;
  } catch (e) {
    console.warn(`Admin API update failed: ${(e as any)?.message || e}`);
    return false;
  }
}

async function main() {
  const token = process.argv[2];
  const mode = process.argv[3];
  if (!token || !mode || !["continuous14h", "flex24h", "ip-spike", "bulk149"].includes(mode)) {
    usage();
    process.exit(1);
  }

  const db = ensureDb();
  console.log(`Using events DB at: ${config.sqliteDataPath}`);
  const udb = ensureUserStoreDb();
  if (udb) console.log(`Using user-store DB at: ${config.sqliteUserStorePath}`);

  const before = countEvents(db, token);

  if (mode === "continuous14h") seedContinuous14h(db, token);
  if (mode === "flex24h") seedFlex24h(db, token);
  if (mode === "ip-spike") seedIpSpike(db, token);
  if (mode === "bulk149") seedBulk149(db, token);

  const after = countEvents(db, token);
  const added = after - before;
  console.log(`Events for token before: ${before}, after: ${after}, added: ${added}`);

  if (added > 0) {
    const service = parseArgFlag('service') || process.env.SEED_SERVICE || 'google-ai';

    // Prefer admin API if provided (updates in-memory store immediately)
    const adminUrl = parseArgFlag('admin-url') || process.env.ADMIN_URL;
    const adminKey = parseArgFlag('admin-key') || process.env.ADMIN_KEY;
    if (adminUrl && adminKey) {
      const okApi = await adminUpdatePromptAndMeta(adminUrl, adminKey, token, added, service);
      if (okApi) return;
    }

    // Fallback: update SQLite user-store directly (only effective if using sqlite store)
    if (udb) {
      const ok1 = incrementUserPromptCount(udb, token, added);
      const ok2 = updateUserMetaPromptCount(udb, token, service, added);
      if (ok1 || ok2) {
        console.log(`SQLite fallback: promptCount += ${added}, meta.promptCounts['${service}'] += ${added} for ${token}`);
        return;
      }
    }

    console.warn('Could not update user promptCount/meta. Provide --admin-url and --admin-key to update in-memory store, or ensure SQLITE_USER_STORE_PATH is used by the server.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
