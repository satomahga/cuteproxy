import { config } from "../../../../config";
import { ForbiddenError } from "../../../../shared/errors";
import { getModelFamilyForRequest, MODEL_FAMILY_SERVICE } from "../../../../shared/models";
import { getAllowedServicesForTier } from "../../../../shared/subscriptions/presets";
import { RequestPreprocessor } from "../index";

/**
 * Ensures the selected model family is enabled by the proxy configuration.
 */
export const validateModelFamily: RequestPreprocessor = (req) => {
  const family = getModelFamilyForRequest(req);
  if (!config.allowedModelFamilies.includes(family)) {
    throw new ForbiddenError(
      `Model family '${family}' is not enabled on this proxy`
    );
  }

  const userTier = req.user?.tier as any;
  if (req.user?.type === "subscription" && userTier) {
    const service = MODEL_FAMILY_SERVICE[family];
    const allowed = getAllowedServicesForTier(userTier);
    if (!allowed.includes(service)) {
      throw new ForbiddenError(
        `Model family '${family}' is not allowed for your subscription tier`
      );
    }
  }
};