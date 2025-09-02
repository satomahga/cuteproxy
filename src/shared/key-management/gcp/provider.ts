import crypto from "crypto";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { PaymentRequiredError } from "../../errors";
import { GcpModelFamily, getGcpModelFamily } from "../../models";
import { createGenericGetLockoutPeriod, Key, KeyProvider } from "..";
import { prioritizeKeys } from "../prioritize-keys";
import { GcpKeyChecker } from "./checker";

// GcpKeyUsage is removed, tokenUsage from base Key interface will be used.
export interface GcpKey extends Key {
  readonly service: "gcp";
  readonly modelFamilies: GcpModelFamily[];
  sonnetEnabled: boolean;
  haikuEnabled: boolean;
  sonnet35Enabled: boolean;

  privateKey?: crypto.webcrypto.CryptoKey;
  /** Cached access token for GCP APIs. */
  accessToken: string;
  accessTokenExpiresAt: number;
}

/**
 * Upon being rate limited, a key will be locked out for this many milliseconds
 * while we wait for other concurrent requests to finish.
 */
const RATE_LIMIT_LOCKOUT = 4000;
/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 500;

export class GcpKeyProvider implements KeyProvider<GcpKey> {
  readonly service = "gcp";

  private keys: GcpKey[] = [];
  private checker?: GcpKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.gcpCredentials?.trim();
    if (!keyConfig) {
      this.log.warn(
        "GCP_CREDENTIALS is not set. GCP API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: GcpKey = {
        key,
        service: this.service,
        modelFamilies: ["gcp-claude"],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `gcp-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        sonnetEnabled: true,
        haikuEnabled: false,
        sonnet35Enabled: false,
        accessToken: "",
        accessTokenExpiresAt: 0,
        tokenUsage: {}, // Initialize new tokenUsage field
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded GCP keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new GcpKeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(model: string) {
    const neededFamily = getGcpModelFamily(model);

    // this is a horrible mess
    // each of these should be separate model families, but adding model
    // families is not low enough friction for the rate at which gcp claude
    // model variants are added.
    const needsSonnet35 =
      model.includes("claude-3-5-sonnet") && neededFamily === "gcp-claude";
    const needsSonnet =
      !needsSonnet35 &&
      model.includes("sonnet") &&
      neededFamily === "gcp-claude";
    const needsHaiku = model.includes("haiku") && neededFamily === "gcp-claude";

    const availableKeys = this.keys.filter((k) => {
      return (
        !k.isDisabled &&
        (k.sonnetEnabled || !needsSonnet) && // sonnet and haiku are both under gcp-claude, while opus is not
        (k.haikuEnabled || !needsHaiku) &&
        (k.sonnet35Enabled || !needsSonnet35) &&
        k.modelFamilies.includes(neededFamily)
      );
    });

    this.log.debug(
      {
        model,
        neededFamily,
        needsSonnet,
        needsHaiku,
        needsSonnet35,
        availableKeys: availableKeys.length,
        totalKeys: this.keys.length,
      },
      "Selecting GCP key"
    );

    if (availableKeys.length === 0) {
      throw new PaymentRequiredError(
        `No GCP keys available for model ${model}`
      );
    }

    const selectedKey = prioritizeKeys(availableKeys)[0];
    selectedKey.lastUsed = Date.now();
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  public disable(key: GcpKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<GcpKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(keyHash: string, modelFamily: GcpModelFamily, usage: { input: number; output: number }) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;

    key.promptCount++;

    if (!key.tokenUsage) {
      key.tokenUsage = {};
    }
    if (!key.tokenUsage[modelFamily]) {
      key.tokenUsage[modelFamily] = { input: 0, output: 0 };
    }

    const currentFamilyUsage = key.tokenUsage[modelFamily]!;
    currentFamilyUsage.input += usage.input;
    currentFamilyUsage.output += usage.output;
  }

  getLockoutPeriod = createGenericGetLockoutPeriod(() => this.keys);

  /**
   * This is called when we receive a 429, which means there are already five
   * concurrent requests running on this key. We don't have any information on
   * when these requests will resolve, so all we can do is wait a bit and try
   * again. We will lock the key for 2 seconds after getting a 429 before
   * retrying in order to give the other requests a chance to finish.
   */
  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + RATE_LIMIT_LOCKOUT;
  }

  public recheck() {
    this.keys.forEach(({ hash }) =>
      this.update(hash, { lastChecked: 0, isDisabled: false, isRevoked: false })
    );
    this.checker?.scheduleNextCheck();
  }

  /**
   * Applies a short artificial delay to the key upon dequeueing, in order to
   * prevent it from being immediately assigned to another request before the
   * current one can be dispatched.
   **/
  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit = key.rateLimitedUntil;
    const nextRateLimit = now + KEY_REUSE_DELAY;

    key.rateLimitedAt = now;
    key.rateLimitedUntil = Math.max(currentRateLimit, nextRateLimit);
  }
}
