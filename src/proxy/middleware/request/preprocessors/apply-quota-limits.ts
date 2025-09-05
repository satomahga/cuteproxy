import { hasAvailableSubscriptionPrompt, ensureSubscriptionPromptCounters } from "../../../../shared/users/user-store";
import { RequestPreprocessor } from "../index";
import { getModelFamilyForRequest, MODEL_FAMILY_SERVICE } from "../../../../shared/models";

export class QuotaExceededError extends Error {
  public quotaInfo: any;
  constructor(message: string, quotaInfo: any) {
    super(message);
    this.name = "QuotaExceededError";
    this.quotaInfo = quotaInfo;
  }
}

// Enforce only subscription daily prompt limits; ignore token-based quotas.
export const applyQuotaLimits: RequestPreprocessor = (req) => {
  const user = req.user;
  if (!user) return;
  if (user.type === "special") return;

  // Enforce per-service daily prompt limit for subscription users
  if (user.type === "subscription") {
    // Ensure daily counters are current
    ensureSubscriptionPromptCounters(user.token);

    const family = getModelFamilyForRequest(req);
    const service = MODEL_FAMILY_SERVICE[family];
    const ok = hasAvailableSubscriptionPrompt({ userToken: user.token, service });
    if (!ok) {
      throw new QuotaExceededError(
        `Daily prompt limit reached for service: ${service}`,
        { type: "subscription_prompt_limit", service }
      );
    }
  }

  // Token quotas are intentionally not enforced here.
  return;
};
