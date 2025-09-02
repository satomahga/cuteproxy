import express, { Router } from "express";
import { createWhitelistMiddleware } from "../shared/cidr";
import { HttpError } from "../shared/errors";
import { injectCsrfToken, checkCsrfToken } from "../shared/inject-csrf";
import { injectLocals } from "../shared/inject-locals";
import { withSession } from "../shared/with-session";
import { config } from "../config";
import { renderPage } from "../info-page";
import { buildInfo } from "../service-info";
import { authorize } from "./auth";
import { loginRouter } from "./login";
import { eventsApiRouter } from "./api/events";
import { usersApiRouter } from "./api/users";
import { usersWebRouter as webRouter } from "./web/manage";
import { logger } from "../logger";
import { keyPool } from "../shared/key-management";
import { abuseStatsApiRouter } from "./api/abuse-stats";

const adminRouter = Router();

const whitelist = createWhitelistMiddleware(
  "ADMIN_WHITELIST",
  config.adminWhitelist
);

if (!whitelist.ranges.length && config.adminKey?.length) {
  logger.error("ADMIN_WHITELIST is empty. No admin requests will be allowed. Set 0.0.0.0/0 to allow all.");
}

adminRouter.use(whitelist);
adminRouter.use(
  express.json({ limit: "20mb" }),
  express.urlencoded({ extended: true, limit: "20mb" })
);
adminRouter.use(withSession);
adminRouter.use(injectCsrfToken);

adminRouter.use("/users", authorize({ via: "header" }), usersApiRouter);
adminRouter.use("/events", authorize({ via: "header" }), eventsApiRouter);
adminRouter.use("/abuse-stats", authorize({ via: "header" }), abuseStatsApiRouter);

// Special endpoint to validate organization verification status for all OpenAI keys
// This checks both gpt-image-1 and o3 streaming access which require verified organizations
adminRouter.post("/validate-gpt-image-keys", authorize({ via: "header" }), async (req, res) => {
  try {
    logger.info("Manual validation of organization verification status initiated");
    
    // Use the specialized validation function that tests each key's organization verification
    // status using o3 streaming and waits for the results
    const results = await keyPool.validateGptImageAccess();
    
    logger.info({
      total: results.total,
      verified: results.verified.length,
      removed: results.removed.length,
      errors: results.errors.length
    }, "Manual organization verification check completed");
    
    return res.json({
      success: true,
      message: "Organization verification check completed",
      results: {
        total: results.total,
        verified: results.verified.length,
        removed: results.removed.length,
        errors: results.errors.length,
        // Only include hashes, not full keys
        verified_keys: results.verified,
        removed_keys: results.removed,
        error_details: results.errors
      }
    });
  } catch (error) {
    logger.error({ error }, "Error validating organization verification status for OpenAI keys");
    return res.status(500).json({ error: "Failed to validate keys", details: error.message });
  }
});

adminRouter.use(checkCsrfToken);
adminRouter.use(injectLocals);
adminRouter.use("/", loginRouter);
adminRouter.use("/manage", authorize({ via: "cookie" }), webRouter);
adminRouter.use("/service-info", authorize({ via: "cookie" }), (req, res) => {
  return res.send(
    renderPage(buildInfo(req.protocol + "://" + req.get("host"), true))
  );
});

adminRouter.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const data: any = { message: err.message, stack: err.stack };
    if (err instanceof HttpError) {
      data.status = err.status;
      res.status(err.status);
      if (req.accepts(["html", "json"]) === "json") {
        return res.json({ error: data });
      }
      return res.render("admin_error", data);
    } else if (err.name === "ForbiddenError") {
      data.status = 403;
      if (err.message === "invalid csrf token") {
        data.message =
          "Invalid CSRF token; try refreshing the previous page before submitting again.";
      }
      return res.status(403).render("admin_error", { ...data, flash: null });
    }
    res.status(500).json({ error: data });
  }
);

export { adminRouter };
