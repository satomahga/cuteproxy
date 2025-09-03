import Database from "better-sqlite3";
import { migrateDatabase } from "../src/shared/database";
import { config } from "../src/config";

function usage() {
  console.log(`Usage:
  ts-node scripts/seed-abuse-events.ts <token> <mode>

Modes:
  continuous14h  -> one event per hour for the last 14 hours (triggers 14h temporary suspension rule)
  flex24h        -> chain of events ≤ 2h apart spanning 24h (triggers 24h continuous rule)
  ip-spike       -> multiple events within the last 10 minutes from 4+ unique IPs (triggers IP spike rule)
`);
}

function ensureDb(): Database.Database {
  const dbPath = config.sqliteDataPath!;
  const db = new Database(dbPath);
  migrateDatabase(undefined, db);
  return db;
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

function seedContinuous14h(db: Database.Database, token: string) {
  const now = Date.now();
  for (let i = 14; i > 0; i--) {
    const ts = new Date(now - i * 60 * 60 * 1000 + 3 * 60 * 1000).toISOString();
    insertEvent(db, { token, ip: "203.0.113.2", date: ts });
  }
  console.log("Seeded 14 hourly events for temporary suspension test.");
}

function seedFlex24h(db: Database.Database, token: string) {
  const now = Date.now();
  // Create a chain of events 90 minutes apart for exactly 24 hours (<= 2h gaps)
  // 16 intervals * 90min = 24 hours; produce 17 events including the last one
  const intervalMs = 90 * 60 * 1000;
  const intervals = 16;
  for (let i = intervals; i >= 0; i--) {
    const ts = new Date(now - i * intervalMs).toISOString();
    insertEvent(db, { token, ip: "203.0.113.3", date: ts });
  }
  console.log("Seeded 24h chain with <=2h gaps for permanent flex rule test.");
}

function seedIpSpike(db: Database.Database, token: string) {
  const base = Date.now() - 8 * 60 * 1000; // within 10 minutes
  const ips = [
    "198.51.100.10",
    "203.0.113.20",
    "192.0.2.30",
    "2001:db8:1::1",
    // add an extra to be safe
    "2001:db8:2::2",
  ];
  for (let i = 0; i < 4; i++) {
    const ts = new Date(base + i * 60 * 1000).toISOString();
    insertEvent(db, { token, ip: ips[i], date: ts });
  }
  console.log("Seeded events from 4 unique IPs within last 10 minutes.");
}

async function main() {
  const token = process.argv[2];
  const mode = process.argv[3];
  if (!token || !mode || !["continuous14h", "flex24h", "ip-spike"].includes(mode)) {
    usage();
    process.exit(1);
  }

  const db = ensureDb();
  if (mode === "continuous14h") seedContinuous14h(db, token);
  if (mode === "flex24h") seedFlex24h(db, token);
  if (mode === "ip-spike") seedIpSpike(db, token);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
