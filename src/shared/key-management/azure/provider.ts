import crypto from "crypto";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { PaymentRequiredError } from "../../errors";
import {
  AzureOpenAIModelFamily,
  getAzureOpenAIModelFamily,
} from "../../models";
import { createGenericGetLockoutPeriod, Key, KeyProvider } from "..";
import { prioritizeKeys } from "../prioritize-keys";
import { AzureOpenAIKeyChecker } from "./checker";

// AzureOpenAIKeyUsage is removed, tokenUsage from base Key interface will be used.
export interface AzureOpenAIKey extends Key {
  readonly service: "azure";
  readonly modelFamilies: AzureOpenAIModelFamily[];
  contentFiltering: boolean;
  modelIds: string[];
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

export class AzureOpenAIKeyProvider implements KeyProvider<AzureOpenAIKey> {
  readonly service = "azure";

  private keys: AzureOpenAIKey[] = [];
  private checker?: AzureOpenAIKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.azureCredentials;
    if (!keyConfig) {
      this.log.warn(
        "AZURE_CREDENTIALS is not set. Azure OpenAI API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: AzureOpenAIKey = {
        key,
        service: this.service,
        modelFamilies: ["azure-gpt4"],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        contentFiltering: false,
        hash: `azu-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        tokenUsage: {}, // Initialize new tokenUsage field
        modelIds: [],
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Azure OpenAI keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new AzureOpenAIKeyChecker(
        this.keys,
        this.update.bind(this)
      );
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(model: string) {
    const neededFamily = getAzureOpenAIModelFamily(model);
    const availableKeys = this.keys.filter(
      (k) => !k.isDisabled && k.modelFamilies.includes(neededFamily)
    );
    if (availableKeys.length === 0) {
      throw new PaymentRequiredError(
        `No keys available for model family '${neededFamily}'.`
      );
    }

    const selectedKey = prioritizeKeys(availableKeys)[0];
    selectedKey.lastUsed = Date.now();
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  public disable(key: AzureOpenAIKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<AzureOpenAIKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(keyHash: string, modelFamily: AzureOpenAIModelFamily, usage: { input: number; output: number }) {
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
