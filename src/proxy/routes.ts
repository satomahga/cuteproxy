import express from "express";
import { addV1 } from "./add-v1";
import { anthropic } from "./anthropic";
import { aws } from "./aws";
import { azure } from "./azure";
import { checkRisuToken } from "./check-risu-token";
import { gatekeeper } from "./gatekeeper";
import { gcp } from "./gcp";
import { googleAI } from "./google-ai";
import { mistralAI } from "./mistral-ai";
import { openai } from "./openai";
import { openaiImage } from "./openai-image";
import { deepseek } from "./deepseek";
import { xai } from "./xai";
import { cohere } from "./cohere";
import { qwen } from "./qwen";
import { moonshot } from "./moonshot";
import { sendErrorToClient } from "./middleware/response/error-generator";
import { antiAbuseMiddleware } from "./middleware/anti-abuse";

const proxyRouter = express.Router();

// Remove `expect: 100-continue` header from requests due to incompatibility
// with node-http-proxy.
proxyRouter.use((req, _res, next) => {
  if (req.headers.expect) {
    delete req.headers.expect;
  }
  next();
});

// Apply body parsers.
proxyRouter.use(
  express.json({ limit: "100mb" }),
  express.urlencoded({ extended: true, limit: "100mb" })
);

// Apply auth/rate limits.
proxyRouter.use(gatekeeper);
proxyRouter.use(checkRisuToken);
proxyRouter.use(antiAbuseMiddleware);

// Initialize request queue metadata.
proxyRouter.use((req, _res, next) => {
  req.startTime = Date.now();
  req.retryCount = 0;
  next();
});

// Proxy endpoints.
proxyRouter.use("/openai", addV1, openai);
proxyRouter.use("/openai-image", addV1, openaiImage);
proxyRouter.use("/anthropic", addV1, anthropic);
proxyRouter.use("/google-ai", addV1, googleAI);
proxyRouter.use("/mistral-ai", addV1, mistralAI);
proxyRouter.use("/aws", aws);
proxyRouter.use("/gcp/claude", addV1, gcp);
proxyRouter.use("/azure/openai", addV1, azure);
proxyRouter.use("/deepseek", addV1, deepseek);
proxyRouter.use("/xai", addV1, xai);
proxyRouter.use("/cohere", addV1, cohere);
proxyRouter.use("/qwen", addV1, qwen);
proxyRouter.use("/moonshot", addV1, moonshot);

// Redirect browser requests to the homepage.
proxyRouter.get("*", (req, res, next) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) {
    res.redirect("/");
  } else {
    next();
  }
});

// Send a fake client error if user specifies an invalid proxy endpoint.
proxyRouter.use((req, res) => {
  sendErrorToClient({
    req,
    res,
    options: {
      title: "Proxy error (HTTP 404 Not Found)",
      message: "The requested proxy endpoint does not exist.",
      model: req.body?.model,
      reqId: req.id,
      format: "unknown",
      obj: {
        proxy_note:
          "Your chat client is using the wrong endpoint. Check the Service Info page for the list of available endpoints.",
        requested_url: req.originalUrl,
      },
    },
  });
});

export { proxyRouter as proxyRouter };
