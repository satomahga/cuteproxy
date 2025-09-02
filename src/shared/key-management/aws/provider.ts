import crypto from "crypto";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { PaymentRequiredError } from "../../errors";
import { AwsBedrockModelFamily, getAwsBedrockModelFamily } from "../../models";
import { findByAnthropicId } from "../../claude-models";
import { createGenericGetLockoutPeriod, Key, KeyProvider } from "..";
import { prioritizeKeys } from "../prioritize-keys";
import { AwsKeyChecker } from "./checker";

// AwsBedrockKeyUsage is removed, tokenUsage from base Key interface will be used.
export interface AwsBedrockKey extends Key {
  readonly service: "aws";
  readonly modelFamilies: AwsBedrockModelFamily[];
  /**
   * The confirmed logging status of this key. This is "unknown" until we
   * receive a response from the AWS API. Keys which are logged, or not
   * confirmed as not being logged, won't be used unless ALLOW_AWS_LOGGING is
   * set.
   */
  awsLoggingStatus: "unknown" | "disabled" | "enabled";
  modelIds: string[];
  inferenceProfileIds: string[];
}

/**
 * Upon being rate limited, a key will be locked out for this many milliseconds
 * while we wait for other concurrent requests to finish.
 */
const RATE_LIMIT_LOCKOUT = 5000;
/**
 * Upon assigning a key, we will wait this many milliseconds before allowing it
 * to be used again. This is to prevent the queue from flooding a key with too
 * many requests while we wait to learn whether previous ones succeeded.
 */
const KEY_REUSE_DELAY = 250;

export class AwsBedrockKeyProvider implements KeyProvider<AwsBedrockKey> {
  readonly service = "aws";

  private keys: AwsBedrockKey[] = [];
  private checker?: AwsKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.awsCredentials?.trim();
    if (!keyConfig) {
      this.log.warn(
        "AWS_CREDENTIALS is not set. AWS Bedrock API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: AwsBedrockKey = {
        key,
        service: this.service,
        modelFamilies: ["aws-claude"],
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        awsLoggingStatus: "unknown",
        hash: `aws-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        modelIds: ["anthropic.claude-3-sonnet-20240229-v1:0"],
        inferenceProfileIds: [],
        tokenUsage: {}, // Initialize new tokenUsage field
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded AWS Bedrock keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new AwsKeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(model: string) {
    let neededVariantId = model;
    // This function accepts both Anthropic/Mistral IDs and AWS IDs.
    // Generally all AWS model IDs are supersets of the original vendor IDs.
    // Claude 2 is the only model that breaks this convention; Anthropic calls
    // it claude-2 but AWS calls it claude-v2.
    if (model.includes("claude-2")) neededVariantId = "claude-v2";
    
    // For Claude models, try to resolve aliases to AWS model IDs
    if (model.includes("claude") && !model.includes("anthropic.")) {
      const claudeMapping = findByAnthropicId(model);
      if (claudeMapping) {
        neededVariantId = claudeMapping.awsId;
      }
    }
    
    const neededFamily = getAwsBedrockModelFamily(model);

    const availableKeys = this.keys.filter((k) => {
      // Select keys which
      return (
        // are enabled
        !k.isDisabled &&
        // are not logged, unless policy allows it
        (config.allowAwsLogging || k.awsLoggingStatus !== "enabled") &&
        // have access to the model family we need
        k.modelFamilies.includes(neededFamily) &&
        // have access to the specific variant we need
        k.modelIds.some((m) => m.includes(neededVariantId))
      );
    });

    this.log.debug(
      {
        requestedModel: model,
        selectedVariant: neededVariantId,
        selectedFamily: neededFamily,
        totalKeys: this.keys.length,
        availableKeys: availableKeys.length,
      },
      "Selecting AWS key"
    );

    if (availableKeys.length === 0) {
      throw new PaymentRequiredError(
        `No AWS Bedrock keys available for model ${model}`
      );
    }

    /**
     * Comparator for prioritizing keys on inference profile compatibility.
     * Requests made via inference profiles have higher rate limits so we want
     * to use keys with compatible inference profiles first.
     */
    const hasInferenceProfile = (
      a: AwsBedrockKey,
      b: AwsBedrockKey
    ) => {
      const aMatch = +a.inferenceProfileIds.some((p) => p.includes(model));
      const bMatch = +b.inferenceProfileIds.some((p) => p.includes(model));
      return aMatch - bMatch;
    };

    const selectedKey = prioritizeKeys(availableKeys, hasInferenceProfile)[0];
    selectedKey.lastUsed = Date.now();
    this.throttle(selectedKey.hash);
    return { ...selectedKey };
  }

  public disable(key: AwsBedrockKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<AwsBedrockKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(keyHash: string, modelFamily: AwsBedrockModelFamily, usage: { input: number; output: number }) {
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
