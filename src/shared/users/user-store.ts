import { applyTierPresetToUser, SubscriptionTier, TIER_PRESETS } from "../subscriptions/presets";
/**
 * Basic user management. Handles creation and tracking of proxy users, personal
 * access tokens, and quota management. Supports in-memory and Firebase Realtime
 * Database persistence stores.
 *
 * Users are identified solely by their personal access token. The token is
 * used to authenticate the user for all proxied requests.
 */

import admin from "firebase-admin";
import schedule from "node-schedule";
import { v4 as uuid } from "uuid";
import type { Database } from 'better-sqlite3';
import { config } from "../../config";
import { logger } from "../../logger";
import { getFirebaseApp } from "../firebase";
import { initSQLiteDB, getDB } from "../sqlite-db"; // Added
import { APIFormat } from "../key-management";
import {
  getAwsBedrockModelFamily,
  getGcpModelFamily,
  getAzureOpenAIModelFamily,
  getClaudeModelFamily,
  getGoogleAIModelFamily,
  getMistralAIModelFamily,
  getOpenAIModelFamily,
  MODEL_FAMILIES,
  MODEL_FAMILY_SERVICE,
  ModelFamily,
  LLMService,
  LLM_SERVICES,
} from "../models";
import { assertNever } from "../utils";
import { User, UserTokenCounts, UserUpdate } from "./schema";

const log = logger.child({ module: "users" });

const INITIAL_TOKENS: Required<UserTokenCounts> = MODEL_FAMILIES.reduce(
  (acc, family) => {
    acc[family] = { input: 0, output: 0 }; // legacy_total is undefined by default
    return acc;
  },
  {} as Record<ModelFamily, { input: number; output: number; legacy_total?: number }>
) as Required<UserTokenCounts>;

const migrateTokenCountsProperty = (
  parsedProperty: any, // Data from DB (JSON.parse result for a specific user's property like tokenCounts)
  defaultConfigForProperty: Record<ModelFamily, number | { input: number; output: number; legacy_total?: number } | undefined> // e.g., INITIAL_TOKENS or config.tokenQuota
): UserTokenCounts => {
  const result = {} as UserTokenCounts;

  for (const family of MODEL_FAMILIES) {
    const dbValue = parsedProperty?.[family];
    const configValue = defaultConfigForProperty[family];

    if (typeof dbValue === 'number') {
      // Case 1: DB has old numeric format - migrate and add legacy_total
      result[family] = { input: dbValue, output: 0, legacy_total: dbValue };
    } else if (typeof dbValue === 'object' && dbValue !== null && (typeof dbValue.input === 'number' || typeof dbValue.output === 'number')) {
      // Case 2: DB has new object format (might or might not have legacy_total from a previous migration)
      result[family] = { input: dbValue.input ?? 0, output: dbValue.output ?? 0, legacy_total: dbValue.legacy_total };
    } else {
      // Case 3: DB value is missing or invalid, use default from config
      if (typeof configValue === 'number') {
        // Default from config is old numeric format (e.g., config.tokenQuota[family]) - migrate and add legacy_total
        result[family] = { input: configValue, output: 0, legacy_total: configValue };
      } else if (typeof configValue === 'object' && configValue !== null && (typeof configValue.input === 'number' || typeof configValue.output === 'number')) {
        // Default from config is new object format (e.g., INITIAL_TOKENS[family])
        result[family] = { input: configValue.input ?? 0, output: configValue.output ?? 0, legacy_total: configValue.legacy_total };
      } else {
        // Ultimate fallback: if configValue is also missing or invalid for this family
        result[family] = { input: 0, output: 0 }; // No legacy_total here
      }
    }
  }
  return result;
};

const users: Map<string, User> = new Map();
const usersToFlush = new Set<string>();
let quotaRefreshJob: schedule.Job | null = null;
let userCleanupJob: schedule.Job | null = null;

export async function init() {
  log.info({ store: config.gatekeeperStore }, "Initializing user store...");
  if (config.gatekeeperStore === "firebase_rtdb") {
    await initFirebase();
  } else if (config.gatekeeperStore === "sqlite") {
    await initSQLite(); // Added
  }
  if (config.quotaRefreshPeriod) {
    const crontab = getRefreshCrontab();
    quotaRefreshJob = schedule.scheduleJob(crontab, refreshAllQuotas);
    if (!quotaRefreshJob) {
      throw new Error(
        "Unable to schedule quota refresh. Is QUOTA_REFRESH_PERIOD set correctly?"
      );
    }
    log.debug(
      { nextRefresh: quotaRefreshJob.nextInvocation() },
      "Scheduled token quota refresh."
    );
  }

  userCleanupJob = schedule.scheduleJob("* * * * *", cleanupExpiredTokens);

  log.info("User store initialized.");
}

/**
 * Creates a new user and returns their token. Optionally accepts parameters
 * for setting an expiry date and/or token limits for temporary users.
 **/
export function createUser(createOptions?: {
  type?: User["type"];
  expiresAt?: number;
  tokenLimits?: User["tokenLimits"];
  tokenRefresh?: User["tokenRefresh"];
  tier?: SubscriptionTier;
}) {
  const token = uuid();
  const newUser: User = {
    token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { ...INITIAL_TOKENS }, // New counts don't have legacy_total
    tokenLimits: createOptions?.tokenLimits ?? MODEL_FAMILIES.reduce((acc, family) => {
      const quota = config.tokenQuota[family];
      // If quota is a number, it's a legacy total limit, store it as such
      acc[family] = typeof quota === 'number' ? { input: quota, output: 0, legacy_total: quota } : (quota || { input: 0, output: 0 });
      return acc;
    }, {} as UserTokenCounts),
    tokenRefresh: createOptions?.tokenRefresh ?? { ...INITIAL_TOKENS }, // Refresh amounts typically start fresh
    createdAt: Date.now(),
    meta: {},
  };

  if (createOptions?.type === "temporary") {
    Object.assign(newUser, {
      type: "temporary",
      expiresAt: createOptions.expiresAt,
    });
  } else if (createOptions?.type === "subscription") {
    const defaultExpiryMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    Object.assign(newUser, {
      type: "subscription",
      tier: createOptions.tier,
      expiresAt: createOptions.expiresAt ?? defaultExpiryMs,
    });
    if (createOptions.tier) {
      applyTierPresetToUser(newUser, createOptions.tier);
    }
  } else {
    Object.assign(newUser, { type: createOptions?.type ?? "normal" });
  }

  users.set(token, newUser);
  usersToFlush.add(token);
  return token;
}

/** Returns the user with the given token if they exist. */
export function getUser(token: string) {
  return users.get(token);
}

/** Returns a list of all users. */
export function getUsers() {
  return Array.from(users.values()).map((user) => ({ ...user }));
}

/**
 * Upserts the given user. Intended for use with the /admin API for updating
 * arbitrary fields on a user; use the other functions in this module for
 * specific use cases. `undefined` values are left unchanged. `null` will delete
 * the property from the user.
 *
 * Returns the upserted user.
 */
export function upsertUser(user: UserUpdate) {
  const existing: User = users.get(user.token) ?? {
    token: user.token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { ...INITIAL_TOKENS }, // New counts don't have legacy_total
    tokenLimits: MODEL_FAMILIES.reduce((acc, family) => {
      const quota = config.tokenQuota[family];
      // If quota is a number, it's a legacy total limit, store it as such
      acc[family] = typeof quota === 'number' ? { input: quota, output: 0, legacy_total: quota } : (quota || { input: 0, output: 0 });
      return acc;
    }, {} as UserTokenCounts),
    tokenRefresh: { ...INITIAL_TOKENS }, // Refresh amounts typically start fresh
    createdAt: Date.now(),
    meta: {},
  };

  const updates: Partial<User> = {};

  for (const field of Object.entries(user)) {
    const [key, value] = field as [keyof User, any]; // already validated by zod
    if (value === undefined || key === "token") continue;
    if (value === null) {
      delete (existing as any)[key];
    } else {
      (updates as any)[key] = value;
    }
  }

  // If this upsert is unbanning a previously disabled user, set a forgiveness watermark
  const wasDisabled = !!existing.disabledAt;
  const disabledFieldTouched = Object.prototype.hasOwnProperty.call(user, "disabledAt");
  const isUnban = wasDisabled && disabledFieldTouched && (user as any).disabledAt === null;
  if (isUnban) {
    const now = Date.now();
    const mergedMeta = { ...(existing.meta || {}), ...(updates.meta as any || {}) } as any;
    mergedMeta.abuseForgivenAfter = now;
    updates.meta = mergedMeta;
  }

  if ((updates as any).tokenCounts) {
    for (const family of MODEL_FAMILIES) {
      (updates as any).tokenCounts[family] ??= { input: 0, output: 0 };
      // The property is now guaranteed to be an object, so the 'number' check is removed.
      // Defaulting individual fields if they are missing.
      const counts = (updates as any).tokenCounts[family]!; // Should not be undefined here
      counts.input ??= 0;
      counts.output ??= 0;
      // legacy_total is optional and not defaulted here if missing
    }
  }
  if ((updates as any).tokenLimits) {
    for (const family of MODEL_FAMILIES) {
      (updates as any).tokenLimits[family] ??= { input: 0, output: 0 };
      // The property is now guaranteed to be an object, so the 'number' check is removed.
      // Defaulting individual fields if they are missing.
      const limits = (updates as any).tokenLimits[family]!; // Should not be undefined here
      limits.input ??= 0;
      limits.output ??= 0;
      // legacy_total is optional and not defaulted here if missing
    }
  }
  // tokenRefresh is a special case where we want to merge the existing and
  // updated values for each model family, ignoring falsy values.
  if ((updates as any).tokenRefresh) {
    const merged = { ...existing.tokenRefresh } as UserTokenCounts;
    for (const family of MODEL_FAMILIES) {
      const updateRefresh = (updates as any).tokenRefresh[family];
      const existingRefresh = existing.tokenRefresh[family];
      merged[family] = {
        input: (updateRefresh?.input || existingRefresh?.input) ?? 0,
        output: (updateRefresh?.output || existingRefresh?.output) ?? 0,
      };
    }
    (updates as any).tokenRefresh = merged;
  }

  const finalUser: User = Object.assign(existing, updates);
  if (finalUser.type === "subscription" && finalUser.tier) {
    applyTierPresetToUser(finalUser, finalUser.tier as SubscriptionTier);
  }

  users.set(user.token, finalUser);
  usersToFlush.add(user.token);

  // Immediately schedule a flush to the database if a persistent store is used.
  if (config.gatekeeperStore === "firebase_rtdb") {
    setImmediate(flushUsers);
  } else if (config.gatekeeperStore === "sqlite") {
    setImmediate(flushUsersToSQLite);
  }

  return users.get(user.token);
}

/** Increments the prompt count for the given user. */
export function incrementPromptCount(token: string) {
  const user = users.get(token);
  if (!user) return;
  user.promptCount++;
  usersToFlush.add(token);
}

/** Increments token consumption for the given user and model. */
export function incrementTokenCount(
  token: string,
  model: string,
  api: APIFormat,
  consumption: { input: number; output: number }
) {
  const user = users.get(token);
  if (!user) return;
  const modelFamily = getModelFamilyForQuotaUsage(model, api);

  // Always track real token usage only on the specific model family
  const existingCounts = user.tokenCounts[modelFamily] ?? { input: 0, output: 0 };
  user.tokenCounts[modelFamily] = {
    input: (existingCounts.input ?? 0) + consumption.input,
    output: (existingCounts.output ?? 0) + consumption.output,
  };
  usersToFlush.add(token);
}

/**
 * Given a user's token and IP address, authenticates the user and adds the IP
 * to the user's list of IPs. Returns the user if they exist and are not
 * disabled, otherwise returns undefined.
 */
export function authenticate(
  token: string,
  ip: string
): { user?: User; result: "success" | "disabled" | "suspended" | "not_found" | "limited" } {
  const user = users.get(token);
  if (!user) return { result: "not_found" };
  if (user.disabledAt) return { result: "disabled" };

  // Temporary suspension check
  const suspendUntil = (user.meta as any)?.suspendUntil as number | undefined;
  if (suspendUntil && suspendUntil > Date.now()) {
    return { result: "suspended" };
  }

  const newIp = !user.ip.includes(ip);

  const userLimit = user.maxIps ?? config.maxIpsPerUser;
  const enforcedLimit =
    user.type === "special" || !userLimit ? Infinity : userLimit;

  if (newIp && user.ip.length >= enforcedLimit) {
    if (config.maxIpsAutoBan) {
      user.ip.push(ip);
      disableUser(token, "IP address limit exceeded.");
      return { result: "disabled" };
    }
    return { result: "limited" };
  } else if (newIp) {
    user.ip.push(ip);
  }

  user.lastUsedAt = Date.now();
  usersToFlush.add(token);
  return { user, result: "success" };
}

export function hasAvailableQuota({
  userToken,
  model,
  api,
  requested,
}: {
  userToken: string;
  model: string;
  api: APIFormat;
  requested: number;
}) {
  const user = users.get(userToken);
  if (!user) return false;
  if (user.type === "special") return true;

  const modelFamily = getModelFamilyForQuotaUsage(model, api);
  const { tokenCounts, tokenLimits } = user;
  const limitConfig = tokenLimits[modelFamily];
  const currentUsage = tokenCounts[modelFamily] ?? { input: 0, output: 0 };

  // If no specific limit object for the family, or if it's essentially unlimited (e.g. input/output are 0 or not set)
  // fall back to checking config.tokenQuota which is a number (total limit).
  if (!limitConfig || (limitConfig.input === 0 && limitConfig.output === 0 && !config.tokenQuota[modelFamily])) {
    return true; // No effective limit
  }

  let effectiveLimit: number;
  if (limitConfig && (limitConfig.input > 0 || limitConfig.output > 0)) {
    // If a specific limit object exists and has positive values, sum them.
    // This assumes the limit is a total limit. If input/output are separate, this logic needs change.
    effectiveLimit = (limitConfig.input ?? Number.MAX_SAFE_INTEGER) + (limitConfig.output ?? Number.MAX_SAFE_INTEGER);
  } else {
    // Fallback to general numeric quota from config if specific limitObj is not effectively set.
    const generalQuota = config.tokenQuota[modelFamily];
    if (typeof generalQuota === 'number' && generalQuota > 0) {
      effectiveLimit = generalQuota;
    } else {
      return true; // No limit defined
    }
  }
  
  // Assuming 'requested' is for input tokens. If 'requested' can be input or output,
  // this needs to be an object {input: number, output: number}.
  // For now, we sum current input & output and add 'requested' to input for checking.
  // This is a simplification. A more robust solution would involve 'requested' being an object.
  const totalConsumed = (currentUsage.input ?? 0) + (currentUsage.output ?? 0) + requested;
  return totalConsumed < effectiveLimit;
}

/**
 * For the given user, sets token limits for each model family to the sum of the
 * current count and the refresh amount, up to the default limit. If a quota is
 * not specified for a model family, it is not touched.
 */
export function refreshQuota(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenQuota } = config;
  const { tokenCounts, tokenLimits, tokenRefresh } = user;
  for (const family of MODEL_FAMILIES) {
    const currentUsage = tokenCounts[family] ?? { input: 0, output: 0 };
    const userRefreshConfig = tokenRefresh[family] ?? { input: 0, output: 0 };
    const globalDefaultQuotaValue = config.tokenQuota[family]; // This is a number or undefined

    let refreshInputAmount = 0;
    let refreshOutputAmount = 0;

    // Prioritize user-specific refresh amounts if they are positive
    if (userRefreshConfig.input > 0 || userRefreshConfig.output > 0) {
      refreshInputAmount = userRefreshConfig.input;
      refreshOutputAmount = userRefreshConfig.output;
    } else if (typeof globalDefaultQuotaValue === 'number' && globalDefaultQuotaValue > 0) {
      // If no user-specific refresh, use the global quota.
      // Distribute the global quota. For simplicity, add to input, or define a rule.
      // Here, let's assume the global quota is a total that primarily refreshes 'input'.
      refreshInputAmount = globalDefaultQuotaValue;
      refreshOutputAmount = 0; // Or some portion of globalDefaultQuotaValue
    }

    if (refreshInputAmount > 0 || refreshOutputAmount > 0) {
      tokenLimits[family] = {
        input: (currentUsage.input ?? 0) + refreshInputAmount,
        output: (currentUsage.output ?? 0) + refreshOutputAmount,
      };
    }
  }
  usersToFlush.add(token);
}

export function resetUsage(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenCounts } = user;
  for (const family of MODEL_FAMILIES) {
    tokenCounts[family] = { input: 0, output: 0 }; // legacy_total is implicitly undefined/removed
  }
  usersToFlush.add(token);
}

/** Disables the given user, optionally providing a reason. */
export function disableUser(token: string, reason?: string) {
  const user = users.get(token);
  if (!user) return;
  user.disabledAt = Date.now();
  user.disabledReason = reason;
  if (!user.meta) {
    user.meta = {};
  }
  // manually banned tokens cannot be refreshed
  user.meta.refreshable = false;
  usersToFlush.add(token);
}

export function getNextQuotaRefresh() {
  if (!quotaRefreshJob) return "never (manual refresh only)";
  return quotaRefreshJob.nextInvocation().getTime();
}

/**
 * Cleans up expired temporary tokens by disabling tokens past their access
 * expiry date and permanently deleting tokens three days after their access
 * expiry date.
 */
function cleanupExpiredTokens() {
  const now = Date.now();
  let disabled = 0;
  let deleted = 0;
  for (const user of users.values()) {
    if (user.type === "temporary") {
      if (user.expiresAt && user.expiresAt < now && !user.disabledAt) {
        disableUser(user.token, "Temporary token expired.");
        if (!user.meta) {
          user.meta = {};
        }
        user.meta.refreshable = config.captchaMode !== "none";
        disabled++;
      }
      const purgeTimeout = config.powTokenPurgeHours * 60 * 60 * 1000;
      if (user.disabledAt && user.disabledAt + purgeTimeout < now) {
        users.delete(user.token);
        usersToFlush.add(user.token);
        deleted++;
      }
    } else if (user.type === "subscription") {
      if (user.expiresAt && user.expiresAt < now && !user.disabledAt) {
        disableUser(user.token, "Subscription expired.");
        disabled++;
      }
    }
  }
  log.trace({ disabled, deleted }, "Expired tokens cleaned up.");
}

function refreshAllQuotas() {
  let count = 0;
  for (const user of users.values()) {
    if (user.type === "temporary") continue;
    refreshQuota(user.token);
    usersToFlush.add(user.token);
    count++;
  }
  log.info(
    { refreshed: count, nextRefresh: quotaRefreshJob!.nextInvocation() },
    "Token quotas refreshed."
  );
}

// TODO: Firebase persistence is pretend right now and just polls the in-memory
// store to sync it with Firebase when it changes. Will refactor to abstract
// persistence layer later so we can support multiple stores.
let firebaseTimeout: NodeJS.Timeout | undefined;
let sqliteInterval: NodeJS.Timeout | undefined; // Added
let flushingToSQLiteInProgress = false; // Added for JS-level lock
const USERS_REF = process.env.FIREBASE_USERS_REF_NAME ?? "users";

async function initSQLite() { // Added
  log.info("Initializing SQLite user store...");
  initSQLiteDB(); // Initialize the DB connection and schema
  await loadUsersFromSQLite();
  // Set up periodic flush for SQLite, similar to Firebase
  sqliteInterval = setInterval(flushUsersToSQLite, 20 * 1000);
  log.info("SQLite user store initialized and users loaded.");
}

async function initFirebase() {
  log.info("Connecting to Firebase...");
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref(USERS_REF);
  const snapshot = await usersRef.once("value");
  const usersData: Record<string, any> | null = snapshot.val(); // Store as 'any' initially for migration
  firebaseTimeout = setInterval(flushUsers, 20 * 1000);

  if (!usersData) {
    log.info("No users found in Firebase.");
    return;
  }

  // migrateTokenCountsProperty is now defined at module scope

  for (const token in usersData) {
    const rawUser = usersData[token];
    const migratedUser: User = {
      ...rawUser, // Spread existing fields
      token: rawUser.token || token, // Ensure token is present
      ip: rawUser.ip || [],
      type: rawUser.type || "normal",
      promptCount: rawUser.promptCount || 0,
      createdAt: rawUser.createdAt || Date.now(),
      // Migrate token fields
      tokenCounts: migrateTokenCountsProperty(rawUser.tokenCounts, INITIAL_TOKENS),
      tokenLimits: migrateTokenCountsProperty(rawUser.tokenLimits, config.tokenQuota),
      tokenRefresh: migrateTokenCountsProperty(rawUser.tokenRefresh, INITIAL_TOKENS),
      meta: rawUser.meta || {},
    };

    let migrated = false;
    if (migratedUser.type === 'normal') {
      migratedUser.type = 'subscription' as any;
      (migratedUser as any).tier = 'free';
      migrated = true;
    }
    if ((migratedUser.type === 'subscription') && (migratedUser as any).tier) {
      // Preserve existing tokenCounts for accurate stats; just apply new tier presets
      applyTierPresetToUser(migratedUser, (migratedUser as any).tier as SubscriptionTier);
      migrated = true;
    }

    // Use the internal map directly to avoid re-triggering upsertUser's default creations
    users.set(token, migratedUser);
    if (migrated) usersToFlush.add(token);
  }
  // Persist any migrations immediately
  setImmediate(flushUsers);
  const numUsers = Object.keys(usersData).length;
  log.info({ users: numUsers }, "Loaded and migrated users from Firebase");
}

async function flushUsers() {
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref(USERS_REF);
  const updates: Record<string, User> = {};
  const deletions: string[] = [];

  for (const token of usersToFlush) {
    const user = users.get(token);
    if (!user) {
      deletions.push(token);
      continue;
    }
    updates[token] = user;
  }

  usersToFlush.clear();

  const numUpdates = Object.keys(updates).length + deletions.length;
  if (numUpdates === 0) {
    return;
  }

  await usersRef.update(updates);
  await Promise.all(deletions.map((token) => usersRef.child(token).remove()));
  log.info(
    { users: Object.keys(updates).length, deletions: deletions.length },
    "Flushed changes to Firebase"
  );
}

async function loadUsersFromSQLite() { // Added
  log.info("Loading users from SQLite...");
  const db = getDB();
  const rows = db.prepare("SELECT * FROM users").all() as any[];
  for (const row of rows) {
    const rawTokenCounts = row.tokenCounts ? JSON.parse(row.tokenCounts) : null;
    const rawTokenLimits = row.tokenLimits ? JSON.parse(row.tokenLimits) : null;
    const rawTokenRefresh = row.tokenRefresh ? JSON.parse(row.tokenRefresh) : null;

    const user: User = {
      token: row.token,
      ip: row.ip ? JSON.parse(row.ip) : [],
      nickname: row.nickname,
      type: row.type,
      tier: row.tier,
      promptCount: row.promptCount,
      tokenCounts: migrateTokenCountsProperty(rawTokenCounts, INITIAL_TOKENS),
      tokenLimits: migrateTokenCountsProperty(rawTokenLimits, config.tokenQuota),
      tokenRefresh: migrateTokenCountsProperty(rawTokenRefresh, INITIAL_TOKENS),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      disabledAt: row.disabledAt,
      disabledReason: row.disabledReason,
      expiresAt: row.expiresAt,
      maxIps: row.maxIps,
      adminNote: row.adminNote,
      meta: row.meta ? JSON.parse(row.meta) : {},
    };

    let migrated = false;
    // Convert normal users to subscription free during migration
    if (user.type === 'normal') {
      user.type = 'subscription' as any;
      (user as any).tier = 'free';
      // do not set expiresAt for free tier unless desired
      migrated = true;
    }

    // Migration: reset quotas for subscription users to new tier presets and zero out usage
    if ((user.type === 'subscription') && (user as any).tier) {
      // Preserve existing tokenCounts for accurate historical stats
      applyTierPresetToUser(user, (user as any).tier as SubscriptionTier);
      migrated = true;
    }

    users.set(user.token, user);
    if (migrated) usersToFlush.add(user.token);
  }
  // Persist migrated users immediately
  await flushUsersToSQLite();
  log.info({ users: users.size }, "Loaded users from SQLite.");
}

async function flushUsersToSQLite() { // Added
  if (flushingToSQLiteInProgress) {
    log.trace("Flush to SQLite already in progress, skipping.");
    return;
  }
  if (usersToFlush.size === 0) {
    return;
  }

  flushingToSQLiteInProgress = true;
  log.trace({ count: usersToFlush.size }, "Starting flush to SQLite.");

  const db = getDB();
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO users (
      token, ip, nickname, type, tier, promptCount, tokenCounts, tokenLimits,
      tokenRefresh, createdAt, lastUsedAt, disabledAt, disabledReason,
      expiresAt, maxIps, adminNote, meta
    ) VALUES (
      @token, @ip, @nickname, @type, @tier, @promptCount, @tokenCounts, @tokenLimits,
      @tokenRefresh, @createdAt, @lastUsedAt, @disabledAt, @disabledReason,
      @expiresAt, @maxIps, @adminNote, @meta
    )
  `);
  const deleteStmt = db.prepare("DELETE FROM users WHERE token = ?");

  let updatedCount = 0;
  let deletedCount = 0;

  const transaction = db.transaction(() => {
    for (const token of usersToFlush) {
      const user = users.get(token);
      if (user) {
        insertStmt.run({
          token: user.token,
          ip: JSON.stringify(user.ip || []),
          nickname: user.nickname ?? null,
          type: user.type,
          tier: (user as any).tier ?? null,
          promptCount: user.promptCount,
          tokenCounts: JSON.stringify(user.tokenCounts || INITIAL_TOKENS),
          tokenLimits: JSON.stringify(user.tokenLimits || migrateTokenCountsProperty(null, config.tokenQuota)),
          tokenRefresh: JSON.stringify(user.tokenRefresh || INITIAL_TOKENS),
          createdAt: user.createdAt,
          lastUsedAt: user.lastUsedAt ?? null,
          disabledAt: user.disabledAt ?? null,
          disabledReason: user.disabledReason ?? null,
          expiresAt: user.expiresAt ?? null,
          maxIps: user.maxIps ?? null,
          adminNote: user.adminNote ?? null,
          meta: JSON.stringify(user.meta || {}),
        });
        updatedCount++;
      } else {
        // User was deleted from in-memory map
        deleteStmt.run(token);
        deletedCount++;
      }
    }
  });

  try {
    transaction();
    usersToFlush.clear();
    if (updatedCount > 0 || deletedCount > 0) {
      log.info({ updated: updatedCount, deleted: deletedCount }, "Flushed user changes to SQLite.");
    }
  } catch (error: any) {
    log.error({
        message: error?.message || "Unknown error during SQLite flush",
        stack: error?.stack,
        code: error?.code, // SQLite errors often have a code
        rawError: error // Log the raw error object for more details
    }, "Error flushing users to SQLite.");
    // Re-add tokens to flush queue if transaction failed, so we can retry
    // This is a simplistic retry, might need more robust error handling
    // Ensure usersToFlush still contains the tokens that failed to process
    // The current logic inside the transaction means usersToFlush is cleared only on success.
    // If transaction fails, usersToFlush would still contain the items from before the attempt.
    // However, if items were added to usersToFlush *during* the failed transaction,
    // they would be processed in the next attempt.
    // For simplicity, the current re-add logic is okay, but could be refined if specific
    // tokens fail consistently.
    usersToFlush.forEach(token => usersToFlush.add(token));
  } finally {
    flushingToSQLiteInProgress = false;
    log.trace("Finished flush to SQLite attempt.");
  }
}

function getModelFamilyForQuotaUsage(
  model: string,
  api: APIFormat
): ModelFamily {
  // "azure" here is added to model names by the Azure key provider to
  // differentiate between Azure and OpenAI variants of the same model.
  if (model.includes("azure")) return getAzureOpenAIModelFamily(model);
  if (model.includes("anthropic.")) return getAwsBedrockModelFamily(model);
  if (model.startsWith("claude-") && model.includes("@"))
    return getGcpModelFamily(model);
  if (model.startsWith("deepseek")) return "deepseek";

  switch (api) {
    case "openai":
    case "openai-text":
    case "openai-responses":
    case "openai-image":
      return getOpenAIModelFamily(model);
    case "anthropic-chat":
    case "anthropic-text":
      return getClaudeModelFamily(model);
    case "google-ai":
      return getGoogleAIModelFamily(model);
    case "mistral-ai":
    case "mistral-text":
      return getMistralAIModelFamily(model);
    default:
      assertNever(api);
  }
}

function getRefreshCrontab() {
  switch (config.quotaRefreshPeriod!) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return "0 0 * * *";
    default:
      return config.quotaRefreshPeriod ?? "0 0 * * *";
  }
}

// Subscription prompt budget helpers (service-level prompt counting)
const toLLMService = (s: string): LLMService | undefined =>
  (LLM_SERVICES as readonly string[]).includes(s) ? (s as LLMService) : undefined;

export function hasAvailableSubscriptionPrompt(params: { userToken: string; service: string; requested?: number }) {
  const { userToken, service } = params;
  const requested = params.requested ?? 1;
  const user = users.get(userToken);
  if (!user) return false;
  if (user.type !== "subscription") return true;
  const tier = (user as any).tier as SubscriptionTier | undefined;
  if (!tier) return true;
  const svc = toLLMService(service);
  const limit = svc ? (TIER_PRESETS[tier].dailyPrompts[svc] || 0) : 0;
  if (limit === 0) return true; // unlimited for this service
  const used = ((user.meta as any)?.promptCounts?.[service] as number) || 0;
  return used + requested <= limit;
}

export function incrementSubscriptionPromptUsage(userToken: string, service: string, count = 1) {
  const user = users.get(userToken);
  if (!user || user.type !== "subscription") return;
  user.meta = user.meta || {};
  const meta = user.meta as any;
  meta.promptCounts = meta.promptCounts || {};
  meta.promptCounts[service] = (meta.promptCounts[service] || 0) + count;
  usersToFlush.add(userToken);
}

function getNextMidnight(offsetHours: number, now = Date.now()): number {
  const offsetMs = offsetHours * 60 * 60 * 1000;
  const d = new Date(now + offsetMs);
  d.setUTCHours(0, 0, 0, 0);
  const next = d.getTime() + 24 * 60 * 60 * 1000;
  return next - offsetMs;
}

function maybeResetPromptCounts(user: User) {
  user.meta = user.meta || {};
  const meta = user.meta as any;
  const now = Date.now();
  const resetAt = (meta.promptCountsResetAt as number | undefined) ?? 0;
  if (!resetAt || resetAt <= now) {
    meta.promptCounts = {};
    meta.promptCountsResetAt = getNextMidnight(3); // (x) время в сторону от UTC, значение между -inf до inf
    meta.promptCountsResetNote = "UpdatesAt";
    usersToFlush.add(user.token);
  }
}

export function ensureSubscriptionPromptCounters(userToken: string) {
  const user = users.get(userToken);
  if (!user || user.type !== "subscription") return;
  maybeResetPromptCounts(user);
}
