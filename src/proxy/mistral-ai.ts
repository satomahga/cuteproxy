import { Request, RequestHandler, Router } from "express";
import { BadRequestError } from "../shared/errors";
import { keyPool } from "../shared/key-management";
import {
  getMistralAIModelFamily,
  MistralAIModelFamily,
  ModelFamily,
} from "../shared/models";
import { config } from "../config";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

// Mistral can't settle on a single naming scheme and deprecates models within
// months of releasing them so this list is hard to keep up to date. 2024-07-28
// https://docs.mistral.ai/platform/endpoints
export const KNOWN_MISTRAL_AI_MODELS = [
  /* Premier models */
  // Mistral Large (top-tier reasoning model)
  "mistral-large-latest",
  "mistral-large-2411", 
  "mistral-large-2407",
  "mistral-large-2402", // older version
  
  // Pixtral Large (multimodal/vision model)
  "pixtral-large-latest",
  "pixtral-large-2411",
  
  // Mistral Saba (language-specialized model)
  "mistral-saba-latest",
  "mistral-saba-2502",
  
  // Codestral (code model)
  "codestral-latest",
  "codestral-2501",
  "codestral-2405",
  
  // Ministral models (edge models)
  "ministral-8b-latest",
  "ministral-8b-2410",
  "ministral-3b-latest",
  "ministral-3b-2410",
  
  // Embedding & Moderation
  "mistral-embed",  
  "mistral-embed-2312",
  "mistral-moderation-latest", 
  "mistral-moderation-2411",

  /* Free models */
  // Mistral Small (with vision in latest version)
  "mistral-small-latest",
  "mistral-small-2503", // v3.1 with vision
  "mistral-small-2402", // older version
  "magistral-small-latest",
  
  // Pixtral 12B (vision model)
  "pixtral-12b-latest",
  "pixtral-12b-2409",
  
  /* Research & Open Models */
  // Mistral Nemo
  "open-mistral-nemo",
  "open-mistral-nemo-2407",
  
  // Earlier Mixtral & Mistral models
  "open-mistral-7b",
  "open-mixtral-8x7b",
  "open-mixtral-8x22b", 
  "open-codestral-mamba",
  "mathstral",
  
  /* Other, too lazy to do it properly now */
  "mistral-medium-latest",
  "mistral-medium-2312",
  "mistral-medium-2505",
  "magistral-medium-latest",
  "mistral-tiny",
  "mistral-tiny-2312",
];

let modelsCache: any = null;
let modelsCacheTime = 0;

export function generateModelList(models = KNOWN_MISTRAL_AI_MODELS) {
  let available = new Set<MistralAIModelFamily>();
  for (const key of keyPool.list()) {
    if (key.isDisabled || key.service !== "mistral-ai") continue;
    key.modelFamilies.forEach((family) =>
      available.add(family as MistralAIModelFamily)
    );
  }
  const allowed = new Set<ModelFamily>(config.allowedModelFamilies);
  available = new Set([...available].filter((x) => allowed.has(x)));

  return models
    .map((id) => ({
      id,
      object: "model",
      created: new Date().getTime(),
      owned_by: "mistral-ai",
    }))
    .filter((model) => available.has(getMistralAIModelFamily(model.id)));
}

const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return res.status(200).json(modelsCache);
  }
  const result = generateModelList();
  modelsCache = { object: "list", data: result };
  modelsCacheTime = new Date().getTime();
  res.status(200).json(modelsCache);
};

const mistralAIResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  if (req.inboundApi === "mistral-text" && req.outboundApi === "mistral-ai") {
    newBody = transformMistralTextToMistralChat(body);
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

export function transformMistralTextToMistralChat(textBody: any) {
  return {
    ...textBody,
    choices: [
      { message: { content: textBody.outputs[0].text, role: "assistant" } },
    ],
    outputs: undefined,
  };
}

const mistralAIProxy = createQueuedProxyMiddleware({
  target: "https://api.mistral.ai",
  mutations: [addKey, finalizeBody],
  blockingResponseHandler: mistralAIResponseHandler,
});

const mistralAIRouter = Router();
mistralAIRouter.get("/v1/models", handleModelRequest);
// General chat completion endpoint.
mistralAIRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    {
      inApi: "mistral-ai",
      outApi: "mistral-ai",
      service: "mistral-ai",
    },
    { beforeTransform: [detectMistralInputApi] }
  ),
  mistralAIProxy
);

/**
 * We can't determine if a request is Mistral text or chat just from the path
 * because they both use the same endpoint. We need to check the request body
 * for either `messages` or `prompt`.
 * @param req
 */
export function detectMistralInputApi(req: Request) {
  const { messages, prompt } = req.body;
  if (messages) {
    req.inboundApi = "mistral-ai";
    req.outboundApi = "mistral-ai";
  } else if (prompt && req.service === "mistral-ai") {
    // Mistral La Plateforme doesn't expose a text completions endpoint.
    throw new BadRequestError(
      "Mistral (via La Plateforme API) does not support text completions. This format is only supported on Mistral via the AWS API."
    );
  } else if (prompt && req.service === "aws") {
    req.inboundApi = "mistral-text";
    req.outboundApi = "mistral-text";
  }
}

export const mistralAI = mistralAIRouter;
