import { RequestHandler } from "express";
import { config } from "../config";
import { getTokenCostUsd, getTokenCostDetailsUsd, prettyTokens } from "./stats"; // Added getTokenCostDetailsUsd
import { redactIp } from "./utils";
import * as userStore from "./users/user-store";

export const injectLocals: RequestHandler = (req, res, next) => {
  // config-related locals
  const quota = config.tokenQuota;
  const sumOfQuotas = Object.values(quota).reduce((a, b) => a + b, 0);

  res.locals.quotasEnabled = sumOfQuotas > 0;
  res.locals.quota = quota;
  res.locals.nextQuotaRefresh = userStore.getNextQuotaRefresh();
  res.locals.persistenceEnabled = config.gatekeeperStore !== "memory";
  res.locals.usersEnabled = config.gatekeeper === "user_token";
  res.locals.imageGenerationEnabled = config.allowedModelFamilies.some(
    (f) => ["dall-e", "azure-dall-e"].includes(f)
  );
  res.locals.showTokenCosts = config.showTokenCosts;
  res.locals.maxIps = config.maxIpsPerUser;

  // flash messages
  if (req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  } else {
    res.locals.flash = null;
  }

  // view helpers
  res.locals.prettyTokens = prettyTokens;
  res.locals.tokenCost = getTokenCostUsd; // Returns total cost as a number
  res.locals.tokenCostDetails = getTokenCostDetailsUsd; // Returns { inputCost, outputCost, totalCost }
  res.locals.redactIp = redactIp;

  next();
};
