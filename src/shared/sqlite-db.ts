import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../logger';

const log = logger.child({ module: 'sqlite-db' });

let db: Database.Database;

export function initSQLiteDB(): Database.Database {
  if (db) {
    return db;
  }

  const dbPath = config.sqliteUserStorePath;
  if (!dbPath) {
    log.error('SQLite user store DB path (SQLITE_USER_STORE_PATH) is not configured.');
    throw new Error('SQLite user store DB path is not configured.');
  }

  log.info({ path: dbPath }, 'Initializing SQLite database for user store...');
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency and performance.
  db.pragma('journal_mode = WAL');

  // Create users table with the latest schema if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      token TEXT PRIMARY KEY,
      ip TEXT, /* JSON string array */
      nickname TEXT,
      type TEXT NOT NULL CHECK(type IN ('normal', 'special', 'temporary', 'subscription')),
      tier TEXT,
      promptCount INTEGER NOT NULL DEFAULT 0,
      tokenCounts TEXT, /* JSON string object */
      tokenLimits TEXT, /* JSON string object */
      tokenRefresh TEXT, /* JSON string object */
      createdAt INTEGER NOT NULL,
      lastUsedAt INTEGER,
      disabledAt INTEGER,
      disabledReason TEXT,
      expiresAt INTEGER,
      maxIps INTEGER,
      adminNote TEXT,
      meta TEXT /* JSON string object */
    );
  `);

  // Migrate schema if the existing table is outdated (missing subscription in CHECK or missing tier column)
  ensureSchemaUpToDate();

  log.info('SQLite database initialized and `users` table created/verified.');
  return db;
}

function ensureSchemaUpToDate() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as { sql: string } | undefined;
  const createSql = row?.sql || '';
  const hasSubscriptionCheck = /CHECK\(type IN \('normal', 'special', 'temporary', 'subscription'\)\)/.test(createSql);
  const hasTierColumn = /\btier\b/.test(createSql);

  if (hasSubscriptionCheck && hasTierColumn) return;

  log.warn({ hasSubscriptionCheck, hasTierColumn }, 'Migrating SQLite users table schema to include subscription type and tier column.');

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users_new (
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

    // Insert copying common columns; missing tier becomes NULL if not present
    try {
      db.exec(`
        INSERT INTO users_new (
          token, ip, nickname, type, tier, promptCount, tokenCounts, tokenLimits, tokenRefresh,
          createdAt, lastUsedAt, disabledAt, disabledReason, expiresAt, maxIps, adminNote, meta
        )
        SELECT 
          token, ip, nickname, type,
          NULL as tier,
          promptCount, tokenCounts, tokenLimits, tokenRefresh,
          createdAt, lastUsedAt, disabledAt, disabledReason, expiresAt, maxIps, adminNote, meta
        FROM users;
      `);
    } catch (e) {
      log.warn({ error: (e as any)?.message }, 'No existing rows to migrate or copy failed; continuing.');
    }

    db.exec('DROP TABLE IF EXISTS users;');
    db.exec('ALTER TABLE users_new RENAME TO users;');
  })();

  log.info('SQLite users table migrated.');
}

export function getDB(): Database.Database {
  if (!db) {
    // This might happen if getDB is called before initSQLiteDB,
    // though user-store should ensure init is called first.
    log.warn('SQLite DB instance requested before initialization. Attempting to initialize now.');
    return initSQLiteDB();
  }
  return db;
}
