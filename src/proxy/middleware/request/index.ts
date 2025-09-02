import type { Request } from "express";

import { ProxyReqManager } from "./proxy-req-manager";
export {
  createPreprocessorMiddleware,
  createEmbeddingsPreprocessorMiddleware,
} from "./preprocessor-factory";

// Preprocessors (runs before request is queued, usually body transformation/validation)
export { applyQuotaLimits } from "./preprocessors/apply-quota-limits";
export { blockZoomerOrigins } from "./preprocessors/block-zoomer-origins";
export { countPromptTokens } from "./preprocessors/count-prompt-tokens";
export { languageFilter } from "./preprocessors/language-filter";
export { setApiFormat } from "./preprocessors/set-api-format";
export { transformOutboundPayload } from "./preprocessors/transform-outbound-payload";
export { validateContextSize } from "./preprocessors/validate-context-size";
export { validateModelFamily } from "./preprocessors/validate-model-family";
export { validateVision } from "./preprocessors/validate-vision";

// Proxy request mutators (runs every time request is dequeued, before proxying, usually for auth/signing)
export { addKey, addKeyForEmbeddingsRequest } from "./mutators/add-key";
export { addAzureKey } from "./mutators/add-azure-key";
export { finalizeBody } from "./mutators/finalize-body";
export { finalizeSignedRequest } from "./mutators/finalize-signed-request";
export { signAwsRequest } from "./mutators/sign-aws-request";
export { signGcpRequest } from "./mutators/sign-vertex-ai-request";
export { stripHeaders } from "./mutators/strip-headers";

/**
 * Middleware that runs prior to the request being queued or handled by
 * http-proxy-middleware. You will not have access to the proxied
 * request/response objects since they have not yet been sent to the API.
 *
 * User will have been authenticated by the proxy's gatekeeper, but the request
 * won't have been assigned an upstream API key yet.
 *
 * Note that these functions only run once ever per request, even if the request
 * is automatically retried by the request queue middleware.
 */
export type RequestPreprocessor = (req: Request) => void | Promise<void>;

/**
 * Middleware that runs immediately before the request is proxied to the
 * upstream API, after dequeueing the request from the request queue.
 *
 * Because these middleware may be run multiple times per request if a retryable
 * error occurs and the request put back in the queue, they must be idempotent.
 * A change manager is provided to allow the middleware to make changes to the
 * request which can be automatically reverted.
 */
export type ProxyReqMutator = (
  changeManager: ProxyReqManager
) => void | Promise<void>;
