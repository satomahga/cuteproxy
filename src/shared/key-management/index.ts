import type { LLMService, ModelFamily } from "../models";
import { KeyPool } from "./key-pool";

/** The request and response format used by a model's API. */
export type APIFormat =
  | "openai"
  | "openai-text"
  | "openai-image"
  | "openai-responses" // OpenAI Responses API (e.g., for o1-pro, o3-pro)
  | "anthropic-chat" // Anthropic's newer messages array format
  | "anthropic-text" // Legacy flat string prompt format
  | "google-ai"
  | "mistral-ai"
  | "mistral-text"

export interface Key {
  /** The API key itself. Never log this, use `hash` instead. */
  readonly key: string;
  /** The service that this key is for. */
  service: LLMService;
  /** The model families that this key has access to. */
  modelFamilies: ModelFamily[];
  /** Whether this key is currently disabled, meaning its quota has been exceeded or it has been revoked. */
  isDisabled: boolean;
  /** Whether this key specifically has been revoked. */
  isRevoked: boolean;
  /** The number of prompts that have been sent with this key. */
  promptCount: number;
  /** The time at which this key was last used. */
  lastUsed: number;
  /** The time at which this key was last checked. */
  lastChecked: number;
  /** Hash of the key, for logging and to find the key in the pool. */
  hash: string;
  /** The time at which this key was last rate limited. */
  rateLimitedAt: number;
  /** The time until which this key is rate limited. */
  rateLimitedUntil: number;
  /** Detailed token usage, separated by input and output, per model family. */
  tokenUsage?: {
    [family in ModelFamily]?: {
      input: number;
      output: number;
      legacy_total?: number; // To store migrated single-number totals
    };
  };
}

/*
KeyPool and KeyProvider's similarities are a relic of the old design where
there was only a single KeyPool for OpenAI keys. Now that there are multiple
supported services, the service-specific functionality has been moved to
KeyProvider and KeyPool is just a wrapper around multiple KeyProviders,
delegating to the appropriate one based on the model requested.

Existing code will continue to call methods on KeyPool, which routes them to
the appropriate KeyProvider or returns data aggregated across all KeyProviders
for service-agnostic functionality.
*/

export interface KeyProvider<T extends Key = Key> {
  readonly service: LLMService;
  init(): void;
  get(model: string, streaming?: boolean): T;
  list(): Omit<T, "key">[];
  disable(key: T): void;
  update(hash: string, update: Partial<T>): void;
  available(): number;
  incrementUsage(hash: string, modelFamily: ModelFamily, usage: { input: number; output: number }): void;
  getLockoutPeriod(model: ModelFamily): number;
  markRateLimited(hash: string): void;
  recheck(): void;
}

export function createGenericGetLockoutPeriod<T extends Key>(
  getKeys: () => T[]
) {
  return function (this: unknown, family?: ModelFamily): number {
    const keys = getKeys();
    const activeKeys = keys.filter(
      (k) => !k.isDisabled && (!family || k.modelFamilies.includes(family))
    );

    if (activeKeys.length === 0) return 0;

    const now = Date.now();
    const rateLimitedKeys = activeKeys.filter((k) => now < k.rateLimitedUntil);
    const anyNotRateLimited = rateLimitedKeys.length < activeKeys.length;

    if (anyNotRateLimited) return 0;

    return Math.min(...activeKeys.map((k) => k.rateLimitedUntil - now));
  };
}

export const keyPool = new KeyPool();
export { AnthropicKey } from "./anthropic/provider";
export { AwsBedrockKey } from "./aws/provider";
export { GcpKey } from "./gcp/provider";
export { AzureOpenAIKey } from "./azure/provider";
export { GoogleAIKey } from "././google-ai/provider";
export { MistralAIKey } from "./mistral-ai/provider";
export { OpenAIKey } from "./openai/provider";
export { DeepseekKey } from "./deepseek/provider";
export { XaiKey } from "./xai/provider";
export { CohereKey } from "./cohere/provider";
export { QwenKey } from "./qwen/provider";
export { MoonshotKey } from "./moonshot/provider";
