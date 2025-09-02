import Database from "better-sqlite3";
import { migrateDatabase } from "../src/shared/database";
import { config } from "../src/config";

function usage() {
  console.log(`Usage:
  ts-node scripts/seed-abuse-events.ts <token> <mode>

Modes:
  persistent     -> one event per hour for the last 36 hours (triggers persistent activity rule)
  continuous12h  -> one event per hour for the last 12 hours (triggers 12h temporary suspension rule)
  ip-spike         -> multiple events within the last 20 minutes from 3+ IPs and subnets (triggers IP/subnet rule)
  ip-same-subnet   -> multiple events within the last 20 minutes from IPs in the same /16 (should NOT trigger cross-subnet)
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

function seedPersistent(db: Database.Database, token: string) {
  const now = Date.now();
  for (let i = 36; i > 0; i--) {
    const ts = new Date(now - i * 60 * 60 * 1000 + 5 * 60 * 1000).toISOString();
    insertEvent(db, { token, ip: "203.0.113.1", date: ts });
  }
  console.log("Seeded 36 hourly events for persistent activity.");
}

function seedContinuous12h(db: Database.Database, token: string) {
  const now = Date.now();
  for (let i = 12; i > 0; i--) {
    const ts = new Date(now - i * 60 * 60 * 1000 + 3 * 60 * 1000).toISOString();
    insertEvent(db, { token, ip: "203.0.113.2", date: ts });
  }
  console.log("Seeded 12 hourly events for temporary suspension test.");
}

function seedIpSpike(db: Database.Database, token: string) {
  const base = Date.now() - 15 * 60 * 1000; // within 20 minutes
  const ips = [
    // Distinct IPv4 /16 subnets
    "198.51.100.10",   // 198.51.0.0/16
    "203.0.113.20",    // 203.0.0.0/16
    "192.0.2.30",      // 192.0.0.0/16
    // Also include an IPv6 from a distinct /48
    "2001:db8:1::1",   // 2001:db8:1::/48
  ];
  for (let i = 0; i < ips.length; i++) {
    const ts = new Date(base + i * 60 * 1000).toISOString();
    insertEvent(db, { token, ip: ips[i], date: ts });
  }
  console.log("Seeded events from multiple IPs/subnets in last 20 minutes.");
}

function seedIpSameSubnet(db: Database.Database, token: string) {
  const base = Date.now() - 10 * 60 * 1000; // within 20 minutes
  const ips = [
    // All in the same IPv4 /16: 46.211.0.0/16
    "46.211.17.236",
    "46.211.30.42",
    "46.211.99.5",
  ];
  for (let i = 0; i < ips.length; i++) {
    const ts = new Date(base + i * 60 * 1000).toISOString();
    insertEvent(db, { token, ip: ips[i], date: ts });
  }
  console.log("Seeded events from multiple IPs within the same /16 in last 20 minutes.");
}

async function main() {
  const token = process.argv[2];
  const mode = process.argv[3];
  if (!token || !mode || !["persistent", "continuous12h", "ip-spike", "ip-same-subnet"].includes(mode)) {
    usage();
    process.exit(1);
  }

  const db = ensureDb();
  if (mode === "persistent") seedPersistent(db, token);
  if (mode === "continuous12h") seedContinuous12h(db, token);
  if (mode === "ip-spike") seedIpSpike(db, token);
  if (mode === "ip-same-subnet") seedIpSameSubnet(db, token);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
