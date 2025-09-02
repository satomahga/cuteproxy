import { Router } from "express";
import ipaddr from "ipaddr.js";
import multer from "multer";
import { z } from "zod";
import { config } from "../../config";
import { HttpError } from "../../shared/errors";
import * as userStore from "../../shared/users/user-store";
import { parseSort, sortBy, paginate } from "../../shared/utils";
import { keyPool } from "../../shared/key-management";
import { LLMService, MODEL_FAMILIES } from "../../shared/models";
import { getTokenCostUsd, prettyTokens } from "../../shared/stats";
import {
  User,
  UserPartialSchema,
  UserSchema,
  UserTokenCounts,
} from "../../shared/users/schema";
import { getLastNImages } from "../../shared/file-storage/image-history";
import { getDatabase, initializeDatabase } from "../../shared/database";
import { blacklists, parseCidrs, whitelists } from "../../shared/cidr";
import { invalidatePowChallenges } from "../../user/web/pow-captcha";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== "application/json") {
      cb(new Error("Invalid file type"));
    } else {
      cb(null, true);
    }
  },
});

router.get("/create-user", (req, res) => {
  const recentUsers = userStore
    .getUsers()
    .sort(sortBy(["createdAt"], false))
    .slice(0, 5);
  res.render("admin_create-user", {
    recentUsers,
    newToken: !!req.query.created,
  });
});

router.get("/anti-abuse", (_req, res) => {
  const wl = [...whitelists.entries()];
  const bl = [...blacklists.entries()];

  res.render("admin_anti-abuse", {
    captchaMode: config.captchaMode,
    difficulty: config.powDifficultyLevel,
    whitelists: wl.map((w) => ({
      name: w[0],
      mode: "whitelist",
      ranges: w[1].ranges,
    })),
    blacklists: bl.map((b) => ({
      name: b[0],
      mode: "blacklist",
      ranges: b[1].ranges,
    })),
  });
});

router.post("/cidr", (req, res) => {
  const body = req.body;
  const valid = z
    .object({
      action: z.enum(["add", "remove"]),
      mode: z.enum(["whitelist", "blacklist"]),
      name: z.string().min(1),
      mask: z.string().min(1),
    })
    .safeParse(body);

  if (!valid.success) {
    throw new HttpError(
      400,
      valid.error.issues.flatMap((issue) => issue.message).join(", ")
    );
  }

  const { mode, name, mask } = valid.data;
  const list = (mode === "whitelist" ? whitelists : blacklists).get(name);
  if (!list) {
    throw new HttpError(404, "List not found");
  }
  if (valid.data.action === "remove") {
    const newRanges = new Set(list.ranges);
    newRanges.delete(mask);
    list.updateRanges([...newRanges]);
    req.session.flash = {
      type: "success",
      message: `${mode} ${name} updated`,
    };
    return res.redirect("/admin/manage/anti-abuse");
  } else if (valid.data.action === "add") {
    const result = parseCidrs(mask);
    if (result.length === 0) {
      throw new HttpError(400, "Invalid CIDR mask");
    }

    const newRanges = new Set([...list.ranges, mask]);
    list.updateRanges([...newRanges]);
    req.session.flash = {
      type: "success",
      message: `${mode} ${name} updated`,
    };
    return res.redirect("/admin/manage/anti-abuse");
  }
});

router.post("/create-user", (req, res) => {
  const body = req.body;

  const base = z.object({ type: UserSchema.shape.type.default("normal") });
  const tempUser = base
    .extend({
      temporaryUserDuration: z.coerce
        .number()
        .int()
        .min(1)
        .max(10080 * 4),
    })
    .merge(
      MODEL_FAMILIES.reduce((schema, model) => {
        return schema.extend({
          [`temporaryUserQuota_${model}`]: z.coerce.number().int().min(0),
        });
      }, z.object({}))
    )
    .transform((data: any) => {
      const expiresAt = Date.now() + data.temporaryUserDuration * 60 * 1000;
      const tokenLimits = MODEL_FAMILIES.reduce((limits, modelFamily) => {
        const quotaValue = data[`temporaryUserQuota_${modelFamily}`];
        if (typeof quotaValue === 'number') {
          limits[modelFamily] = { input: quotaValue, output: 0, legacy_total: quotaValue };
        } else {
          limits[modelFamily] = { input: 0, output: 0 };
        }
        return limits;
      }, {} as UserTokenCounts);
      return { ...data, expiresAt, tokenLimits };
    });

  const createSchema = body.type === "temporary" ? tempUser : base;
  const result = createSchema.safeParse(body);
  if (!result.success) {
    throw new HttpError(
      400,
      result.error.issues.flatMap((issue) => issue.message).join(", ")
    );
  }

  userStore.createUser({ ...result.data });
  return res.redirect(`/admin/manage/create-user?created=true`);
});

router.get("/view-user/:token", async (req, res) => {
  let user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");

  let recentActivity: any = null;
  try {
    let db;
    try {
      db = getDatabase();
    } catch {
      try {
        await initializeDatabase();
        db = getDatabase();
      } catch {
        recentActivity = null;
        throw new Error("Database not initialized");
      }
    }
    const now = Date.now();
    const since20 = new Date(now - 20 * 60 * 1000).toISOString();
    const rows = db
      .prepare(`SELECT ip FROM events WHERE userToken = ? AND date >= ?`)
      .all(user.token, since20) as { ip: string }[];

    const uniqIps = new Set<string>();
    const uniqSubnets = new Set<string>();
    for (const r of rows) {
      uniqIps.add(r.ip);
      try {
        const parsed = ipaddr.parse(r.ip);
        if (parsed.kind() === "ipv4") {
          const parts = parsed.toNormalizedString().split(".");
          uniqSubnets.add(`${parts[0]}.${parts[1]}.0.0/16`);
        } else if (parsed.kind() === "ipv6") {
          const parts = parsed.toNormalizedString().split(":");
          uniqSubnets.add(`${parts.slice(0, 4).join(":")}::/48`);
        }
      } catch {}
    }

    const since12 = new Date(now - 12 * 60 * 60 * 1000 - 10 * 60 * 1000).toISOString();
    const ev12 = db
      .prepare(`SELECT date FROM events WHERE userToken = ? AND date >= ? ORDER BY date ASC`)
      .all(user.token, since12) as { date: string }[];
    let continuous12h = false;
    if (ev12.length > 0) {
      const buckets12 = new Set<number>();
      const startHour12 = Math.floor((now - 12 * 60 * 60 * 1000) / (60 * 60 * 1000));
      for (const e of ev12) {
        const ts = Date.parse(e.date);
        if (!Number.isFinite(ts)) continue;
        buckets12.add(Math.floor(ts / (60 * 60 * 1000)));
      }
      continuous12h = [...Array(12).keys()].every((i) => buckets12.has(startHour12 + i));
    }

    recentActivity = {
      last30MinIps: Array.from(uniqIps).slice(0, 50),
      last30MinIpsCount: uniqIps.size,
      last30MinSubnetsCount: uniqSubnets.size,
      continuousActivity12h: continuous12h,
    };


  } catch (e) {
    recentActivity = null;
  }

  res.render("admin_view-user", { user, recentActivity, maxIps: config.maxIpsPerUser, quota: config.tokenQuota, quotasEnabled: !!config.quotaRefreshPeriod });
});

router.get("/list-users", (req, res) => {
  const sort = parseSort(req.query.sort) || ["sumTokens", "createdAt"];
  const requestedPageSize =
    Number(req.query.perPage) || Number(req.cookies.perPage) || 1000;
  const perPage = Math.max(1, Math.min(1000, requestedPageSize));
  const users = userStore
    .getUsers()
    .map((user) => {
      const sums = getSumsForUser(user);
      return { ...user, ...sums };
    })
    .sort(sortBy(sort, false));

  const page = Number(req.query.page) || 1;
  const { items, ...pagination } = paginate(users, page, perPage);

  return res.render("admin_list-users", {
    sort: sort.join(","),
    users: items,
    ...pagination,
  });
});

router.get("/import-users", (_req, res) => {
  res.render("admin_import-users");
});

router.post("/import-users", upload.single("users"), (req, res) => {
  if (!req.file) throw new HttpError(400, "No file uploaded");

  const data = JSON.parse(req.file.buffer.toString());
  
  // Transform old token count format to new format
  const transformedUsers = data.users.map((user: any) => {
    if (user.tokenCounts) {
      const transformedTokenCounts: any = {};
      for (const [family, value] of Object.entries(user.tokenCounts)) {
        if (typeof value === 'number') {
          // Old format: just a number (legacy_total)
          transformedTokenCounts[family] = {
            input: 0,
            output: 0,
            legacy_total: value
          };
        } else if (typeof value === 'object' && value !== null) {
          // New format or partially new format
          transformedTokenCounts[family] = {
            input: (value as any).input || 0,
            output: (value as any).output || 0,
            legacy_total: (value as any).legacy_total
          };
        }
      }
      user.tokenCounts = transformedTokenCounts;
    }
    
    // Also handle tokenLimits and tokenRefresh the same way
    if (user.tokenLimits) {
      const transformedTokenLimits: any = {};
      for (const [family, value] of Object.entries(user.tokenLimits)) {
        if (typeof value === 'number') {
          transformedTokenLimits[family] = {
            input: 0,
            output: 0,
            legacy_total: value
          };
        } else if (typeof value === 'object' && value !== null) {
          transformedTokenLimits[family] = {
            input: (value as any).input || 0,
            output: (value as any).output || 0,
            legacy_total: (value as any).legacy_total
          };
        }
      }
      user.tokenLimits = transformedTokenLimits;
    }
    
    if (user.tokenRefresh) {
      const transformedTokenRefresh: any = {};
      for (const [family, value] of Object.entries(user.tokenRefresh)) {
        if (typeof value === 'number') {
          transformedTokenRefresh[family] = {
            input: 0,
            output: 0,
            legacy_total: value
          };
        } else if (typeof value === 'object' && value !== null) {
          transformedTokenRefresh[family] = {
            input: (value as any).input || 0,
            output: (value as any).output || 0,
            legacy_total: (value as any).legacy_total
          };
        }
      }
      user.tokenRefresh = transformedTokenRefresh;
    }
    
    return user;
  });
  
  const result = z.array(UserPartialSchema).safeParse(transformedUsers);
  if (!result.success) throw new HttpError(400, result.error.toString());

  const upserts = result.data.map((user) => userStore.upsertUser(user));
  req.session.flash = {
    type: "success",
    message: `${upserts.length} users imported`,
  };
  res.redirect("/admin/manage/import-users");
});

router.get("/export-users", (_req, res) => {
  res.render("admin_export-users");
});

router.get("/export-users.json", (_req, res) => {
  const users = userStore.getUsers();
  res.setHeader("Content-Disposition", "attachment; filename=users.json");
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({ users }, null, 2));
});

router.get("/abuse-stats", (_req, res) => {
  const users = userStore.getUsers();
  const now = Date.now();
  const isSuspended = (u: any) => {
    const m = (u?.meta || {}) as any;
    return typeof m.suspendUntil === "number" && m.suspendUntil > now;
  };

  const activeTokens = users.filter((u) => !u.disabledAt && !isSuspended(u)).length;
  const blockedTokens = users.filter((u) => !!u.disabledAt).length;
  const suspendedTokens = users.filter((u) => isSuspended(u)).length;

  const blockedByReason: Record<string, number> = {};
  const suspendedByReason: Record<string, number> = {};
  users.forEach((u) => {
    if (u.disabledAt) {
      const reason = u.disabledReason || "Unknown";
      blockedByReason[reason] = (blockedByReason[reason] || 0) + 1;
    }
    if (isSuspended(u)) {
      const reason = (u.meta as any)?.suspendReason || "Suspended";
      suspendedByReason[reason] = (suspendedByReason[reason] || 0) + 1;
    }
  });

  const bannedList = users
    .filter((u) => !!u.disabledAt)
    .map((u) => ({
      token: u.token,
      nickname: u.nickname,
      reason: u.disabledReason || "Unknown",
      when: u.disabledAt!,
    }))
    .sort((a, b) => b.when - a.when)
    .slice(0, 5000);

  const suspendedList = users
    .filter((u) => isSuspended(u))
    .map((u) => ({
      token: u.token,
      nickname: u.nickname,
      reason: (u.meta as any)?.suspendReason || "Suspended",
      until: (u.meta as any)?.suspendUntil as number,
    }))
    .sort((a, b) => b.until - a.until)
    .slice(0, 5000);

  res.render("admin_abuse-stats", { activeTokens, blockedTokens, blockedByReason, suspendedTokens, suspendedByReason, bannedList, suspendedList });
});

router.get("/", (_req, res) => {
  res.render("admin_index");
});

router.post("/edit-user/:token", (req, res) => {
  const result = UserPartialSchema.safeParse({
    ...req.body,
    token: req.params.token,
  });
  if (!result.success) {
    throw new HttpError(
      400,
      result.error.issues.flatMap((issue) => issue.message).join(", ")
    );
  }

  userStore.upsertUser(result.data);
  return res.status(200).json({ success: true });
});

router.post("/reactivate-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");

  userStore.upsertUser({
    token: user.token,
    disabledAt: null,
    disabledReason: null,
  });
  return res.sendStatus(204);
});

router.post("/unsuspend-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");
  const meta = { ...(user.meta || {}) } as any;
  delete meta.suspendUntil;
  delete meta.suspendReason;
  userStore.upsertUser({ token: user.token, meta });
  return res.redirect(`/admin/manage/view-user/${user.token}`);
});

router.post("/suspend-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");
  const reason = (req.body && typeof req.body.reason === 'string' && req.body.reason.trim()) || "Anti-Abuse: Temporary suspension (manual 12h)";
  const meta = { ...(user.meta || {}) } as any;
  const now = Date.now();
  const until = now + 12 * 60 * 60 * 1000;
  meta.suspendUntil = until;
  meta.suspendReason = reason;
  meta.twelveHourViolations = Number(meta.twelveHourViolations || 0) + 1;

  // If reaching 3 violations, permanently disable
  if (meta.twelveHourViolations >= 3) {
    const disableReason = (meta.ipSubnetViolations && meta.ipSubnetViolations >= 1)
      ? "Anti-Abuse: Escalation (3x 12h + 1x IP/Subnet)"
      : "Anti-Abuse: Escalation (3x 12h)";
    userStore.disableUser(user.token, disableReason);
    meta.abuseReason = disableReason;
    meta.abuseAt = now;
  }

  userStore.upsertUser({ token: user.token, meta });
  return res.redirect(`/admin/manage/view-user/${user.token}`);
});

router.post("/disable-user/:token", (req, res) => {
  const user = userStore.getUser(req.params.token);
  if (!user) throw new HttpError(404, "User not found");

  userStore.disableUser(req.params.token, req.body.reason);
  return res.sendStatus(204);
});

router.post("/refresh-user-quota", (req, res) => {
  const user = userStore.getUser(req.body.token);
  if (!user) throw new HttpError(404, "User not found");

  userStore.refreshQuota(user.token);
  req.session.flash = {
    type: "success",
    message: "User's quota was refreshed",
  };
  return res.redirect(`/admin/manage/view-user/${user.token}`);
});

router.post("/maintenance", (req, res) => {
  const action = req.body.action;
  let flash = { type: "", message: "" };
  switch (action) {
    case "recheck": {
      const checkable: LLMService[] = [
        "openai",
        "anthropic",
        "aws",
        "gcp",
        "azure",
        "google-ai"
      ];
      checkable.forEach((s) => keyPool.recheck(s));
      const keyCount = keyPool
        .list()
        .filter((k) => checkable.includes(k.service)).length;

      flash.type = "success";
      flash.message = `Scheduled recheck of ${keyCount} keys.`;
      break;
    }
    case "resetQuotas": {
      const users = userStore.getUsers();
      users.forEach((user) => userStore.refreshQuota(user.token));
      const { claude, gpt4, turbo } = config.tokenQuota;
      flash.type = "success";
      flash.message = `All users' token quotas reset to ${turbo} (Turbo), ${gpt4} (GPT-4), ${claude} (Claude).`;
      break;
    }
    case "resetCounts": {
      const users = userStore.getUsers();
      users.forEach((user) => userStore.resetUsage(user.token));
      flash.type = "success";
      flash.message = `All users' token usage records reset.`;
      break;
    }
    case "downloadImageMetadata": {
      const data = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          generations: getLastNImages(),
        },
        null,
        2
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=image-metadata-${new Date().toISOString()}.json`
      );
      res.setHeader("Content-Type", "application/json");
      return res.send(data);
    }
    case "expireTempTokens": {
      const users = userStore.getUsers();
      const temps = users.filter((u) => u.type === "temporary");
      temps.forEach((user) => {
        user.expiresAt = Date.now();
        user.disabledReason = "Admin forced expiration.";
        userStore.upsertUser(user);
      });
      invalidatePowChallenges();
      flash.type = "success";
      flash.message = `${temps.length} temporary users marked for expiration.`;
      break;
    }
    case "cleanTempTokens": {
      const users = userStore.getUsers();
      const disabledTempUsers = users.filter(
        (u) => u.type === "temporary" && u.expiresAt && u.expiresAt < Date.now()
      );
      disabledTempUsers.forEach((user) => {
        user.disabledAt = 1; //will be cleaned up by the next cron job
        userStore.upsertUser(user);
      });
      flash.type = "success";
      flash.message = `${disabledTempUsers.length} disabled temporary users marked for cleanup.`;
      break;
    }
    case "setDifficulty": {
      const selected = req.body["pow-difficulty"];
      const valid = ["low", "medium", "high", "extreme"];
      const isNumber = Number.isInteger(Number(selected));
      if (!selected || !valid.includes(selected) && !isNumber) {
        throw new HttpError(400, "Invalid difficulty " + selected);
      }
      config.powDifficultyLevel = isNumber ? Number(selected) : selected;
      invalidatePowChallenges();
      break;
    }
    case "generateTempIpReport": {
      const tempUsers = userStore
        .getUsers()
        .filter((u) => u.type === "temporary");
      const ipv4RangeMap = new Map<string, Set<string>>();
      const ipv6RangeMap = new Map<string, Set<string>>();

      tempUsers.forEach((u) => {
        u.ip.forEach((ip) => {
          try {
            const parsed = ipaddr.parse(ip);
            if (parsed.kind() === "ipv4") {
              const subnet =
                parsed.toNormalizedString().split(".").slice(0, 3).join(".") +
                ".0/24";
              const userSet = ipv4RangeMap.get(subnet) || new Set();
              userSet.add(u.token);
              ipv4RangeMap.set(subnet, userSet);
            } else if (parsed.kind() === "ipv6") {
              const subnet =
                parsed.toNormalizedString().split(":").slice(0, 4).join(":") +
                "::/48";
              const userSet = ipv6RangeMap.get(subnet) || new Set();
              userSet.add(u.token);
              ipv6RangeMap.set(subnet, userSet);
            }
          } catch (e) {
            req.log.warn(
              { ip, error: e.message },
              "Invalid IP address; skipping"
            );
          }
        });
      });

      const ipv4Ranges = Array.from(ipv4RangeMap.entries())
        .map(([subnet, userSet]) => ({
          subnet,
          distinctTokens: userSet.size,
        }))
        .sort((a, b) => b.distinctTokens - a.distinctTokens);

      const ipv6Ranges = Array.from(ipv6RangeMap.entries())
        .map(([subnet, userSet]) => ({
          subnet,
          distinctTokens: userSet.size,
        }))
        .sort((a, b) => {
          if (a.distinctTokens === b.distinctTokens) {
            return a.subnet.localeCompare(b.subnet);
          }
          return b.distinctTokens - a.distinctTokens;
        });

      const data = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          ipv4Ranges,
          ipv6Ranges,
        },
        null,
        2
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename=temp-ip-report-${new Date().toISOString()}.json`
      );
      res.setHeader("Content-Type", "application/json");
      return res.send(data);
    }
    default: {
      throw new HttpError(400, "Invalid action");
    }
  }

  req.session.flash = flash;
  const referer = req.get("referer");

  return res.redirect(referer || "/admin/manage");
});

router.get("/download-stats", (_req, res) => {
  return res.render("admin_download-stats");
});

router.post("/generate-stats", (req, res) => {
  const body = req.body;

  const valid = z
    .object({
      anon: z.coerce.boolean().optional().default(false),
      sort: z.string().optional().default("prompts"),
      maxUsers: z.coerce
        .number()
        .int()
        .min(5)
        .max(1000)
        .optional()
        .default(1000),
      tableType: z.enum(["code", "markdown"]).optional().default("markdown"),
      format: z
        .string()
        .optional()
        .default("# Stats\n{{header}}\n{{stats}}\n{{time}}"),
    })
    .strict()
    .safeParse(body);

  if (!valid.success) {
    throw new HttpError(
      400,
      valid.error.issues.flatMap((issue) => issue.message).join(", ")
    );
  }

  const { anon, sort, format, maxUsers, tableType } = valid.data;
  const users = userStore.getUsers();

  let totalTokens = 0;
  let totalCost = 0;
  let totalPrompts = 0;
  let totalIps = 0;

  const lines = users
    .map((u) => {
      const sums = getSumsForUser(u);
      totalTokens += sums.sumTokens;
      totalCost += sums.sumCost;
      totalPrompts += u.promptCount;
      totalIps += u.ip.length;

      const getName = (u: User) => {
        const id = `...${u.token.slice(-5)}`;
        const banned = !!u.disabledAt;
        let nick = anon || !u.nickname ? "Anonymous" : u.nickname;

        if (tableType === "markdown") {
          nick = banned ? `~~${nick}~~` : nick;
          return `${nick.slice(0, 18)} | ${id}`;
        } else {
          // Strikethrough doesn't work within code blocks
          const dead = !!u.disabledAt ? "[dead] " : "";
          nick = `${dead}${nick}`;
          return `${nick.slice(0, 18).padEnd(18)} ${id}`.padEnd(27);
        }
      };

      const user = getName(u);
      const prompts = `${u.promptCount} proompts`.padEnd(14);
      const ips = `${u.ip.length} IPs`.padEnd(8);
      const tokens = `${sums.prettyUsage} tokens`.padEnd(30);
      const sortField = sort === "prompts" ? u.promptCount : sums.sumTokens;
      return { user, prompts, ips, tokens, sortField };
    })
    .sort((a, b) => b.sortField - a.sortField)
    .map(({ user, prompts, ips, tokens }, i) => {
      const pos = tableType === "markdown" ? (i + 1 + ".").padEnd(4) : "";
      return `${pos}${user} | ${prompts} | ${ips} | ${tokens}`;
    })
    .slice(0, maxUsers);

  const strTotalPrompts = `${totalPrompts} proompts`;
  const strTotalIps = `${totalIps} IPs`;
  const strTotalTokens = `${prettyTokens(totalTokens)} tokens`;
  const strTotalCost = `US$${totalCost.toFixed(2)} cost`;
  const header = `!!!Note ${users.length} users | ${strTotalPrompts} | ${strTotalIps} | ${strTotalTokens} | ${strTotalCost}`;
  const time = `\n-> *(as of ${new Date().toISOString()})* <-`;

  let table = [];
  table.push(lines.join("\n"));

  if (valid.data.tableType === "markdown") {
    table = ["User||Prompts|IPs|Usage", "---|---|---|---|---", ...table];
  } else {
    table = ["```text", ...table, "```"];
  }

  const result = format
    .replace("{{header}}", header)
    .replace("{{stats}}", table.join("\n"))
    .replace("{{time}}", time);

  res.setHeader(
    "Content-Disposition",
    `attachment; filename=proxy-stats-${new Date().toISOString()}.md`
  );
  res.setHeader("Content-Type", "text/markdown");
  res.send(result);
});

function getSumsForUser(user: User) {
  const sums = MODEL_FAMILIES.reduce(
    (s, model) => {
      const counts = user.tokenCounts[model] ?? { input: 0, output: 0, legacy_total: undefined };
      // Ensure inputTokens and outputTokens are numbers, defaulting to 0 if NaN or undefined
      const inputTokens = Number(counts.input) || 0;
      const outputTokens = Number(counts.output) || 0;
      // We could also consider legacy_total here if input and output are 0
      // For now, sumTokens and sumCost will be based on current input/output.
      s.sumTokens += inputTokens + outputTokens;
      s.sumCost += getTokenCostUsd(model, inputTokens, outputTokens);
      return s;
    },
    { sumTokens: 0, sumCost: 0, prettyUsage: "" }
  );
  sums.prettyUsage = `${prettyTokens(sums.sumTokens)} ($${sums.sumCost.toFixed(
    2
  )})`;
  return sums;
}

export { router as usersWebRouter };
