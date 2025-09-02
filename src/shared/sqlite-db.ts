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

  // Create users table
  // Note: JSON fields (ip, tokenCounts, etc.) are stored as TEXT.
  // Timestamps are stored as INTEGER (Unix epoch milliseconds).
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      token TEXT PRIMARY KEY,
      ip TEXT, /* JSON string array */
      nickname TEXT,
      type TEXT NOT NULL CHECK(type IN ('normal', 'special', 'temporary')),
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

  log.info('SQLite database initialized and `users` table created/verified.');
  return db;
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
