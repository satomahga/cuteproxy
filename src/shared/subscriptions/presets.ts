import { LLMService, MODEL_FAMILY_SERVICE, MODEL_FAMILIES, ModelFamily } from "../models";
import { User, UserTokenCounts } from "../users/schema";

export type SubscriptionTier = "free" | "proxy1" | "proxy2" | "proxy3";

type TierPreset = {
  allowedServices: LLMService[];
  contextCaps: Partial<Record<LLMService, number>>;
  dailyPrompts: Partial<Record<LLMService, number>>;
};

export const TIER_PRESETS: Record<SubscriptionTier, TierPreset> = {
  free: {
    allowedServices: ["google-ai", "deepseek", "mistral-ai"],
    contextCaps: {
      "google-ai": 50000,
      "deepseek": 30000,
    },
    dailyPrompts: {
      "google-ai": 150,
      "deepseek": 150,
    },
  },
  proxy1: {
    allowedServices: ["google-ai", "deepseek"],
    contextCaps: {
      "google-ai": 100000,
      "deepseek": 60000,
    },
    dailyPrompts: {
      "google-ai": 500,
      "deepseek": 500,
    },
  },
  proxy2: {
    allowedServices: ["google-ai", "deepseek", "openai", "xai"],
    contextCaps: {
      "google-ai": 200000,
      "deepseek": 120000,
      "openai": 60000,
      // xai (Grok) unlimited unless constrained by global proxy limit
    },
    dailyPrompts: {
      // GPT family limited to 600 prompts/day; others effectively unlimited in this preset
      "openai": 600,
    },
  },
  proxy3: {
    // Highest tier in this proxy setup
    allowedServices: ["google-ai", "deepseek", "openai", "anthropic", "xai"],
    contextCaps: {
      "google-ai": 400000,
      "deepseek": 120000,
      "anthropic": 125000,
      "openai": 200000,
      // xai (Grok) unlimited unless constrained by global proxy limit
    },
    dailyPrompts: {
      // Unlimited for this tier
    },
  },
};

export function applyTierPresetToUser(user: User, tier: SubscriptionTier): User {
  const limits: UserTokenCounts = {} as UserTokenCounts;
  for (const family of MODEL_FAMILIES) {
    limits[family] = { input: 0, output: 0 } as any;
  }
  user.tokenLimits = limits;
  return user;
}

export function getAllowedServicesForTier(tier?: SubscriptionTier): LLMService[] {
  if (!tier) return [];
  return TIER_PRESETS[tier].allowedServices;
}

export function getContextCapForTier(tier: SubscriptionTier | undefined, service: LLMService): number | undefined {
  if (!tier) return undefined;
  return TIER_PRESETS[tier].contextCaps[service];
}
