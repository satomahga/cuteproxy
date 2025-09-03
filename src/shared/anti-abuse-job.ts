import schedule from "node-schedule";
import ipaddr from "ipaddr.js";
import { getDatabase } from "./database";
import { getUser, getUsers, upsertUser, disableUser } from "./users/user-store";
import { logger } from "../logger";
import { config } from "../config";

const log = logger.child({ module: "anti-abuse-job" });

const HOURS_14_MS = 14 * 60 * 60 * 1000;
const HOURS_24_MS = 24 * 60 * 60 * 1000;
const MINUTES_10_MS = 10 * 60 * 1000;
const MAX_GAP_2H_MS = 2 * 60 * 60 * 1000;
const GRACE_14H_MS = 10 * 60 * 1000; // Align with middleware/UI grace window

let job: schedule.Job | null = null;

export function startAntiAbuseEnforcer() {
  if (job) return; // already started
  // Run every minute
  job = schedule.scheduleJob("* * * * *", async () => {
    try {
      enforceForAllUsers();
    } catch (err) {
      log.error({ err }, "Anti-abuse enforcer failed");
    }
  });
  log.info("Anti-abuse background enforcer started (every 1 minute)");
}

export function stopAntiAbuseEnforcer() {
  if (job) {
    job.cancel();
    job = null;
  }
}

function enforceForAllUsers() {
  const db = getDatabase();
  const users = getUsers();
  const now = Date.now();

  for (const user of users) {
    try {
      if (user.disabledAt) continue;

      const meta = { ...(user.meta || {}) } as any;
      const activeSuspension = typeof meta.suspendUntil === "number" && meta.suspendUntil > now;
      const fourteenCount = Number((meta as any).fourteenHourViolations ?? (meta as any).twelveHourViolations ?? 0);
      const ipSubnetCount = Number(meta.ipSubnetViolations || 0);
      const ignoreBefore = typeof meta.abuseForgivenAfter === 'number' ? meta.abuseForgivenAfter : 0;

      if (config.enableAntiAbuse14hContinuous) {
        const since14 = new Date(Math.max(now - HOURS_14_MS - GRACE_14H_MS, ignoreBefore)).toISOString();
        const events14 = db
          .prepare(`SELECT date FROM events WHERE userToken = ? AND date >= ? ORDER BY date ASC`)
          .all(user.token, since14) as { date: string }[];

        let fourteenHourContinuous = false;
        if (events14.length > 0) {
          const buckets14 = new Set<number>();
          const startHour14 = Math.floor((now - HOURS_14_MS) / (60 * 60 * 1000));
          for (const e of events14) {
            const ts = Date.parse(e.date);
            if (!Number.isFinite(ts)) continue;
            const hourIndex = Math.floor(ts / (60 * 60 * 1000));
            buckets14.add(hourIndex);
          }
          fourteenHourContinuous = [...Array(14).keys()].every((i) => buckets14.has(startHour14 + i));
        }

        if (fourteenHourContinuous) {
          if (!activeSuspension) {
            const newFourteenCount = fourteenCount + 1;
            if (newFourteenCount >= 3) {
              const reason = ipSubnetCount >= 1 ? "Anti-Abuse: Escalation (3x 14h + 1x IP Spike)" : "Anti-Abuse: Escalation (3x 14h)";
              disableUser(user.token, reason);
              const newMeta = { ...meta, abuseReason: reason, abuseAt: now, fourteenHourViolations: newFourteenCount };
              upsertUser({ token: user.token, meta: newMeta });
              log.info({ token: user.token.slice(-6) }, "User disabled by background enforcer: 3x 14h violations");
              continue;
            } else {
              const until = now + HOURS_14_MS;
              const newMeta = {
                ...meta,
                suspendUntil: until,
                suspendReason: "Anti-Abuse: Temporary suspension (14h continuous activity)",
                fourteenHourViolations: newFourteenCount,
              };
              upsertUser({ token: user.token, meta: newMeta });
              log.info({ token: user.token.slice(-6) }, "User suspended 14h by background enforcer (continuous activity)");
            }
          }
        }
      }

      if (config.enableAntiAbuse24hFlex) {
        const sinceFlex = new Date(Math.max(now - (HOURS_24_MS + MAX_GAP_2H_MS), ignoreBefore)).toISOString();
        const evFlex = db
          .prepare(`SELECT date FROM events WHERE userToken = ? AND date >= ? ORDER BY date ASC`)
          .all(user.token, sinceFlex) as { date: string }[];
        if (evFlex.length > 0) {
          const stamps = evFlex
            .map((e) => Date.parse(e.date))
            .filter((t) => Number.isFinite(t))
            .sort((a, b) => a - b) as number[];
          const last = stamps[stamps.length - 1];
          if (now - last <= MAX_GAP_2H_MS) {
            let start = last;
            for (let i = stamps.length - 2; i >= 0; i--) {
              if (stamps[i + 1] - stamps[i] <= MAX_GAP_2H_MS) {
                start = stamps[i];
              } else {
                break;
              }
            }
            if (last - start >= HOURS_24_MS) {
              const flexCount = Number(meta.twentyFourHourFlexViolations || 0);
              const reason = "Anti-Abuse: 24h continuous usage (<=2h gaps)";
              disableUser(user.token, reason);
              const newMeta = { ...meta, abuseReason: reason, abuseAt: now, twentyFourHourFlexViolations: flexCount + 1 };
              upsertUser({ token: user.token, meta: newMeta });
              log.info({ token: user.token.slice(-6) }, "User disabled by background enforcer: 24h continuous with <=2h gaps");
              continue;
            }
          }
        }
      }

      if (config.enableAntiAbuseIpSpike) {
        const since10 = new Date(Math.max(now - MINUTES_10_MS, ignoreBefore)).toISOString();
        const rows = db
          .prepare(`SELECT ip FROM events WHERE userToken = ? AND date >= ?`)
          .all(user.token, since10) as { ip: string }[];

        const uniqueIps = new Set<string>();
        for (const r of rows) {
          uniqueIps.add(r.ip);
        }
        const ipSpike = uniqueIps.size >= 4;

        if (ipSpike) {
          const baseReason = "Anti-Abuse: Suspicious IP Address Spike";
          const escalate = fourteenCount >= 3;
          const reason = escalate ? "Anti-Abuse: Escalation (3x 14h + 1x IP Spike)" : baseReason;
          disableUser(user.token, reason);
          const newMeta = { ...meta, abuseReason: reason, abuseAt: now, ipSubnetViolations: ipSubnetCount + 1 };
          upsertUser({ token: user.token, meta: newMeta });
          log.info({ token: user.token.slice(-6) }, "User disabled by background enforcer: IP address spike");
        }
      }
    } catch (err) {
      log.warn({ err, token: user.token.slice(-6) }, "Anti-abuse enforcement failed for user");
    }
  }
}

function toSubnet(ip: string): string | undefined {
  try {
    const parsed = ipaddr.parse(ip);
    if (parsed.kind() === "ipv4") {
      const parts = parsed.toNormalizedString().split(".");
      return `${parts[0]}.${parts[1]}.0.0/16`;
    } else if (parsed.kind() === "ipv6") {
      const parts = parsed.toNormalizedString().split(":");
      return `${parts.slice(0, 4).join(":")}::/48`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
