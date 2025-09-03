import type { RequestHandler } from "express";
import { getDatabase, initializeDatabase } from "../../shared/database";
import { disableUser, getUser, upsertUser } from "../../shared/users/user-store";
import { sendErrorToClient } from "./response/error-generator";
import ipaddr from "ipaddr.js";
import { config } from "../../config";

const HOURS_14_MS = 14 * 60 * 60 * 1000;
const HOURS_24_MS = 24 * 60 * 60 * 1000;
const MINUTES_10_MS = 10 * 60 * 1000;
const MAX_GAP_2H_MS = 2 * 60 * 60 * 1000;
const GRACE_14H_MS = 10 * 60 * 1000;

export const antiAbuseMiddleware: RequestHandler = async (req, res, next) => {
  const user = req.user;
  if (!user) return next();

  try {
    const now = Date.now();
    let db;
    try {
      db = getDatabase();
    } catch {
      try {
        await initializeDatabase();
        db = getDatabase();
      } catch {
        return next();
      }
    }

    const curr = getUser(user.token);
    const m = { ...(curr?.meta || {}) } as any;
    const ignoreBefore = typeof m.abuseForgivenAfter === 'number' ? m.abuseForgivenAfter : 0;

    // IP spike detection: 10 minutes window / 4 unique IPs -> permanent disable
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
        const fourteenCount = Number(m.fourteenHourViolations ?? m.twelveHourViolations ?? 0);
        const ipCount = Number(m.ipSubnetViolations || 0);
        const escalate = fourteenCount >= 3;

        const baseReason = "Anti-Abuse: Suspicious IP Address Spike";
        const reason = escalate ? "Anti-Abuse: Escalation (3x 14h + 1x IP Spike)" : baseReason;

        disableUser(user.token, reason);
        try {
          const meta = { ...m, abuseReason: reason, abuseAt: Date.now(), ipSubnetViolations: ipCount + 1 };
          upsertUser({ token: user.token, meta });
        } catch {}
        return sendErrorToClient({
          req,
          res,
          options: {
            title: `Proxy gatekeeper error (HTTP 403)`,
            message: `Forbidden: Anti-Abuse triggered (${reason})`,
            format: "unknown",
            statusCode: 403,
            reqId: req.id,
            obj: {
              rule: "ip_spike",
              uniqueIps: uniqueIps.size,
            },
          },
        });
      }
    }

    // Check 24h continuous usage with <=2h gaps -> permanent disable
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
            const fourteenCount = Number(m.fourteenHourViolations ?? m.twelveHourViolations ?? 0);
            const ipCount = Number(m.ipSubnetViolations || 0);
            const count = Number(m.twentyFourHourFlexViolations || 0);
            const reason = "Anti-Abuse: 24h continuous usage (<=2h gaps)";
            disableUser(user.token, reason);
            try {
              const meta = { ...m, abuseReason: reason, abuseAt: Date.now(), twentyFourHourFlexViolations: count + 1 };
              upsertUser({ token: user.token, meta });
            } catch {}
            return sendErrorToClient({
              req,
              res,
              options: {
                title: `Proxy gatekeeper error (HTTP 403)`,
                message: `Forbidden: Anti-Abuse triggered (${reason})`,
                format: "unknown",
                statusCode: 403,
                reqId: req.id,
                obj: { rule: "continuous_24h_with_2h_breaks" },
              },
            });
          }
        }
      }
    }

    // Next, check 14h consecutive hourly activity -> temporary 14h suspension / escalation
    if (config.enableAntiAbuse14hContinuous) {
      const since14 = new Date(Math.max(now - HOURS_14_MS - GRACE_14H_MS, ignoreBefore)).toISOString();
      const events14 = db
        .prepare(
          `SELECT date FROM events WHERE userToken = ? AND date >= ? ORDER BY date ASC`
        )
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
        const nowMs = Date.now();
        const m = { ...(curr?.meta || {}) } as any;
        const activeSuspension = typeof m.suspendUntil === 'number' && m.suspendUntil > nowMs;
        const fourteenCount = Number(m.fourteenHourViolations ?? m.twelveHourViolations ?? 0);
        const ipCount = Number(m.ipSubnetViolations || 0);

        if (!activeSuspension && fourteenCount + 1 >= 3) {
          const reason = ipCount >= 1
            ? "Anti-Abuse: Escalation (3x 14h + 1x IP Spike)"
            : "Anti-Abuse: Escalation (3x 14h)";
          disableUser(user.token, reason);
          try {
            const meta = { ...m, abuseReason: reason, abuseAt: nowMs, fourteenHourViolations: fourteenCount + 1 };
            upsertUser({ token: user.token, meta });
          } catch {}
          return sendErrorToClient({
            req,
            res,
            options: {
              title: `Proxy gatekeeper error (HTTP 403)`,
              message: `Forbidden: ${reason}`,
              format: "unknown",
              statusCode: 403,
              reqId: req.id,
              obj: { rule: "escalation_ban", fourteenHourViolations: fourteenCount + 1, ipSubnetViolations: ipCount },
            },
          });
        }

        if (!activeSuspension) {
          const until = nowMs + HOURS_14_MS;
          const meta = { ...m, suspendUntil: until, suspendReason: "Anti-Abuse: Temporary suspension (14h continuous activity)", fourteenHourViolations: fourteenCount + 1 };
          upsertUser({ token: user.token, meta });
          return sendErrorToClient({
            req,
            res,
            options: {
              title: `Proxy gatekeeper error (HTTP 403)`,
              message: `Forbidden: User temporarily suspended until ${new Date(until).toISOString()}`,
              format: "unknown",
              statusCode: 403,
              reqId: req.id,
              obj: { rule: "fourteen_hour_continuous_activity", suspendUntil: until, fourteenHourViolations: fourteenCount + 1 },
            },
          });
        }
        return sendErrorToClient({
          req,
          res,
          options: {
            title: `Proxy gatekeeper error (HTTP 403)`,
            message: `Forbidden: ${m.suspendReason || 'User temporarily suspended'}`,
            format: "unknown",
            statusCode: 403,
            reqId: req.id,
            obj: { rule: "already_suspended", suspendUntil: m.suspendUntil },
          },
        });
      }
    }

    return next();
  } catch (_err) {
    return next();
  }
};

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
