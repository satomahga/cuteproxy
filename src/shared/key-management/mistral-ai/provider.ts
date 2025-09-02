import crypto from "crypto";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { HttpError } from "../../errors";
import { MistralAIModelFamily, getMistralAIModelFamily } from "../../models";
import { createGenericGetLockoutPeriod, Key, KeyProvider } from "..";
import { prioritizeKeys } from "../prioritize-keys";
import { MistralAIKeyChecker } from "./checker";

// MistralAIKeyUsage is removed, tokenUsage from base Key interface will be used.
export interface MistralAIKey extends Key {
  readonly service: "mistral-ai";
  readonly modelFamilies: MistralAIModelFamily[];
}

/**
 * Upon being rate limited, a key will be locked out for this many milliseconds
 * while we wait for other concurrent requests to finish.
 */
const RATE_LIMIT_LOCKOUT = 2000;
/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 500;

export class MistralAIKeyProvider implements KeyProvider<MistralAIKey> {
  readonly service = "mistral-ai";

  private keys: MistralAIKey[] = [];
  private checker?: MistralAIKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.mistralAIKey?.trim();
    if (!keyConfig) {
      this.log.warn(
        "MISTRAL_AI_KEY is not set. Mistral AI API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: MistralAIKey = {
        key,
        service: this.service,
        modelFamilies: [
          "mistral-tiny",
          "mistral-small",
          "mistral-medium",
          "mistral-large",
        ],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `mst-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        tokenUsage: {}, // Initialize new tokenUsage field
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Mistral AI keys.");
  }

  public init() {
    if (config.checkKeys) {
      const updateFn = this.update.bind(this);
      this.checker = new MistralAIKeyChecker(this.keys, updateFn);
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(_model: string) {
    const availableKeys = this.keys.filter((k) => !k.isDisabled);
    if (availableKeys.length === 0) {
      throw new HttpError(402, "No Mistral AI keys available");
    }

    const selectedKey = prioritizeKeys(availableKeys)[0];
    selectedKey.lastUsed = Date.now();
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  public disable(key: MistralAIKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<MistralAIKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(keyHash: string, modelFamily: MistralAIModelFamily, usage: { input: number; output: number }) {
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

  public recheck() {}

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
