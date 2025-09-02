import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { MoonshotKey, keyPool } from "../shared/key-management";
import { isMoonshotModel, isMoonshotVisionModel } from "../shared/api-schemas/moonshot";
import { logger } from "../logger";

const log = logger.child({ module: "proxy", service: "moonshot" });
let modelsCache: any = null;
let modelsCacheTime = 0;

const moonshotResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  res.status(200).json({ ...body, proxy: body.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  try {
    const modelToUse = "moonshot-v1-8k";
    const moonshotKey = keyPool.get(modelToUse, "moonshot") as MoonshotKey;
    
    if (!moonshotKey || !moonshotKey.key) {
      log.warn("No valid Moonshot key available for model listing");
      throw new Error("No valid Moonshot API key available");
    }

    // Fetch models from Moonshot API
    const response = await axios.get("https://api.moonshot.cn/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${moonshotKey.key}`
      },
    });

    if (!response.data || !response.data.data) {
      throw new Error("Unexpected response format from Moonshot API");
    }

    // Format response to ensure OpenAI compatibility
    const models = {
      object: "list",
      data: response.data.data.map((model: any) => ({
        id: model.id,
        object: "model",
        created: model.created || Math.floor(Date.now() / 1000),
        owned_by: model.owned_by || "moonshot",
        permission: model.permission || [],
        root: model.root || model.id,
        parent: model.parent || null,
      })),
    };

    log.debug({ modelCount: models.data.length }, "Retrieved models from Moonshot API");

    // Cache the response
    modelsCache = models;
    modelsCacheTime = new Date().getTime();
    return models;
  } catch (error) {
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error fetching Moonshot models"
      );
    } else {
      log.error({ error }, "Unknown error fetching Moonshot models");
    }
    
    // Return a default list of known Moonshot models as fallback
    return {
      object: "list",
      data: [
        { id: "moonshot-v1-8k", object: "model", created: 1678888000, owned_by: "moonshot" },
        { id: "moonshot-v1-32k", object: "model", created: 1678888000, owned_by: "moonshot" },
        { id: "moonshot-v1-128k", object: "model", created: 1678888000, owned_by: "moonshot" },
      ],
    };
  }
};

const handleModelRequest: RequestHandler = async (_req, res) => {
  try {
    const models = await getModelsResponse();
    res.status(200).json(models);
  } catch (error) {
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error handling model request"
      );
    } else {
      log.error({ error }, "Unknown error handling model request");
    }
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

// Function to handle partial mode for Moonshot
function handlePartialMode(req: Request) {
  if (!process.env.NO_MOONSHOT_PARTIAL && req.body.messages && Array.isArray(req.body.messages)) {
    const msgs = req.body.messages;
    if (msgs.at(-1)?.role !== 'assistant') return;

    let i = msgs.length - 1;
    let content = '';
    
    while (i >= 0 && msgs[i].role === 'assistant') {
      // Consolidate consecutive assistant messages
      content = msgs[i--].content + content;
    }
    
    // Replace consecutive assistant messages with single message with partial: true
    msgs.splice(i + 1, msgs.length, { role: 'assistant', content, partial: true });
    log.debug("Consolidated assistant messages and enabled partial mode for Moonshot request");
  }
}

// Function to handle vision model content transformation
function handleVisionContent(req: Request) {
  const model = req.body.model;
  
  if (isMoonshotVisionModel(model) && req.body.messages) {
    // Ensure vision content is properly formatted
    req.body.messages = req.body.messages.map((msg: any) => {
      if (msg.content && typeof msg.content === 'string') {
        // Keep string content as is for non-vision requests
        return msg;
      }
      return msg;
    });
  }
}

// Function to count tokens for Moonshot models
function countMoonshotTokens(req: Request) {
  const model = req.body.model;
  
  if (isMoonshotModel(model)) {
    if (req.promptTokens) {
      log.debug(
        { tokens: req.promptTokens, model },
        "Estimated token count for Moonshot prompt"
      );
    }
  }
}

// Handle rate limit errors for Moonshot
async function handleMoonshotRateLimitError(req: Request, error: any) {
  if (error.response?.status === 429) {
    log.warn({ model: req.body.model }, "Moonshot rate limit hit, rotating key");
    
    const currentKey = req.key as MoonshotKey;
    keyPool.markRateLimited(currentKey);
    
    // Try to get a new key
    const newKey = keyPool.get(req.body.model, "moonshot") as MoonshotKey;
    if (newKey.hash !== currentKey.hash) {
      req.key = newKey;
      return true; // Retry with new key
    }
  }
  return false;
}

const moonshotProxy = createQueuedProxyMiddleware({
  mutations: [
    addKey,
    finalizeBody
  ],
  target: "https://api.moonshot.cn",
  blockingResponseHandler: moonshotResponseHandler,
});

const moonshotRouter = Router();

// Chat completions endpoint
moonshotRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "moonshot" },
    { afterTransform: [ handlePartialMode, handleVisionContent, countMoonshotTokens ] }
  ),
  moonshotProxy
);

// Embeddings endpoint
moonshotRouter.post(
  "/v1/embeddings",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "moonshot" },
    { afterTransform: [ countMoonshotTokens ] }
  ),
  moonshotProxy
);

// Models endpoint
moonshotRouter.get("/v1/models", handleModelRequest);

export const moonshot = moonshotRouter;
