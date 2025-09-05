import express, { Request, Response, NextFunction } from "express";
import { addV1 } from "./add-v1";
import { gatekeeper } from "./gatekeeper";
import { checkRisuToken } from "./check-risu-token";
import { anthropic } from "./anthropic";
import { aws } from "./aws";
import { azure } from "./azure";
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

// ФОРМАТ: "prefix/modelId"
// этим займётся АСТЕРА
// БЕЗжопа ему асфальтом 
const CUSTOM_MODELS: string[] = [
  // OpenAI
  "openai/gpt-4o-mini",
  "openai/gpt-4o",
  "openai/o1-pro",
  "openai/o3-pro",
  // Anthropic
  "anthropic/claude-3-5-sonnet-20241022",
  // AWS Bedrock Anthropic
  "aws/anthropic.claude-3-5-sonnet-20241022-v2:0",
  // Google AI
  "google-ai/gemini-1.5-pro",
  "google-ai/gemini-1.5-flash",
  // Mistral
  "mistral-ai/mistral-large-latest",
  // DeepSeek
  "deepseek/deepseek-chat",
  // "xai/grok-2",
  // "cohere/command-r",
  // "qwen/qwen2.5-72b-instruct",
  // "moonshot/moonshot-v1-8k",
];

const proxyRouter = express.Router();

proxyRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.headers.expect) delete req.headers.expect;
  next();
});

// https://gitgud.io/yae-miko/oai-reverse-proxy поддержка для изображений, насколько я понимаю
proxyRouter.use(
  express.json({ limit: "100mb" }),
  express.urlencoded({ extended: true, limit: "100mb" })
);

proxyRouter.use(gatekeeper);
proxyRouter.use(checkRisuToken);
proxyRouter.use(antiAbuseMiddleware);

proxyRouter.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).startTime = Date.now();
  (req as any).retryCount = 0;
  next();
});

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

function getPrefixFromModel(model: string): string | null {
  if (!model) return null;
  const parts = model.split("/");
  if (!model.includes("/") && parts.length === 1) return null;
  return parts[0] + "/";
}

// нужно протестировать код на OpenAI и Anthropic совместимость туда и обратно (трансформатор в последующих ПР)
function handleClaudeRequest(req: Request, res: Response, next: NextFunction) { // /v1/messages и /v1/complete для Claude моделей
  const model = req.body?.model as string;
  if (!model) return next();

  const provider = getPrefixFromModel(model);
  if (provider) req.body.model = model.slice(provider.length);

  switch (true) {
    case model.startsWith("claude") && model.includes("@2024"):
    case model.startsWith("gcp/"):
      return gcp(req, res, next);
    case model.startsWith("claude-"):
    case model.startsWith("anthropic/"):
      return anthropic(req, res, next);
    default:
    case model.startsWith("aws/"):
      return aws(req, res, next);
  }
}

function handleUniversalRequest(req: Request, res: Response, next: NextFunction) {
  const model = req.body?.model as string;

  if (!model) return openai(req, res, next);

  const provider = getPrefixFromModel(model);
  if (provider) req.body.model = model.slice(provider.length);

  switch (true) {
    case model.startsWith("claude-"):
    case model.startsWith("anthropic/"):
      return anthropic(req, res, next);

    case model.startsWith("claude") && model.includes("@2024"):
    case model.startsWith("gcp/"):
      return gcp(req, res, next);

    case model.startsWith("mistral.mistral"):
    case model.startsWith("anthropic.claude"):
    case model.startsWith("aws/"):
      return aws(req, res, next);

    case model.startsWith("gemini-"):
    case model.startsWith("models/gemini-"):
    case model.startsWith("google-ai/"):
      return googleAI(req, res, next);

    case model.startsWith("mistral-"):
    case model.startsWith("open-codestral-"):
    case model.startsWith("open-mistral-"):
    case model.startsWith("mistral-ai/"):
      return mistralAI(req, res, next);

    case model.startsWith("deepseek"):
      return deepseek(req, res, next);

    case model.startsWith("azure/"):
      return azure(req, res, next);

    case model.startsWith("xai/"):
      return xai(req, res, next);
    case model.startsWith("cohere/"):
      return cohere(req, res, next);
    case model.startsWith("qwen/"):
      return qwen(req, res, next);
    case model.startsWith("moonshot/"):
      return moonshot(req, res, next);

    default:
    case model.startsWith("openai/"):
      return openai(req, res, next);
  }
}

type ModelDataType = {
  id: string;
  object: string;
  created: number;
  owned_by?: string;
};

function buildUniversalModels(): ModelDataType[] {
  const now = Date.now();
  const data = CUSTOM_MODELS.map((fullId) => {
    // owned_by это префикс (например "openai" для "openai/gpt-4o")
    const firstSlash = fullId.indexOf("/");
    const owned_by = firstSlash > 0 ? fullId.slice(0, firstSlash) : "unknown";
    return {
      id: fullId,
      object: "model",
      created: now,
      owned_by,
    } as ModelDataType;
  });

  
  return data.slice().sort((a, b) => a.id.localeCompare(b.id));
}

function handleModelsRequest(_req: Request, res: Response) {
  const data = buildUniversalModels();
  return res.status(200).json({ object: "list", data });
}

const universalRouter = express.Router();

universalRouter.get("/v1/models", handleModelsRequest);

universalRouter.post("/v1/messages", handleClaudeRequest);
universalRouter.post("/v1/complete", handleClaudeRequest);

universalRouter.post("/v1/chat/completions", handleUniversalRequest);

universalRouter.post("/v1/images/generations", openaiImage);

universalRouter.post("/v1/completions", deepseek);

universalRouter.post(
  "/:apiVersion(v1alpha|v1beta)/models/:modelId/:method(generateContent|streamGenerateContent)",
  addV1,
  googleAI
);

proxyRouter.use("/", addV1, universalRouter);

proxyRouter.get("*", (req: Request, res: Response, next: NextFunction) => {
  const isBrowser = req.headers["user-agent"]?.includes("Mozilla");
  if (isBrowser) res.redirect("/");
  else next();
});

proxyRouter.use((req: Request, res: Response) => {
  sendErrorToClient({
    req,
    res,
    options: {
      title: "Proxy error (HTTP 404 Not Found)",
      message: "The requested proxy endpoint does not exist.",
      model: (req as any).body?.model,
      reqId: (req as any).id,
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