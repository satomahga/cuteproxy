import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { QwenKey, keyPool } from "../shared/key-management";
import { 
  isQwenModel, 
  isQwenThinkingModel, 
  normalizeMessages, 
  isQwen3Model,
  isThinkingVariant,
  isNonThinkingVariant,
  getBaseModelName
} from "../shared/api-schemas/qwen";
import { logger } from "../logger";

const log = logger.child({ module: "proxy", service: "qwen" });
let modelsCache: any = null;
let modelsCacheTime = 0;

const qwenResponseHandler: ProxyResHandlerWithBody = async (
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
    // Get a Qwen key directly
    const modelToUse = "qwen-plus"; // Use any Qwen model here - just for key selection
    const qwenKey = keyPool.get(modelToUse, "qwen") as QwenKey;
    
    if (!qwenKey || !qwenKey.key) {
      log.warn("No valid Qwen key available for model listing");
      throw new Error("No valid Qwen API key available");
    }

    // Fetch models directly from Qwen API
    const response = await axios.get("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${qwenKey.key}`
      },
    });

    if (!response.data || !response.data.data) {
      throw new Error("Unexpected response format from Qwen API");
    }

    // Extract models
    const models = response.data;
    
    // Ensure we have all known Qwen models in the list
    const knownQwenModels = [
      "qwen-max",
      "qwen-max-latest",
      "qwen-max-2025-01-25",
      "qwen-plus",
      "qwen-plus-latest",
      "qwen-plus-2025-01-25",
      "qwen-turbo",
      "qwen-turbo-latest",
      "qwen-turbo-2024-11-01",
      "qwen3-235b-a22b",
      "qwen3-32b",
      "qwen3-30b-a3b"
    ];
    
    // Add thinking capability flag to models that support it
    if (models.data && Array.isArray(models.data)) {
      // Create a set of existing model IDs for quick lookup
      const existingModelIds = new Set(models.data.map((model: any) => model.id));
      
      // Filter out base Qwen3 models since we'll add variants instead
      models.data = models.data.filter((model: any) => {
        return !isQwen3Model(model.id) || isThinkingVariant(model.id) || isNonThinkingVariant(model.id);
      });
      
      // Add any missing models from our known list
      knownQwenModels.forEach(modelId => {
        if (!existingModelIds.has(modelId)) {
          models.data.push({
            id: modelId,
            object: "model",
            created: Date.now(),
            owned_by: "qwen",
            capabilities: isQwenThinkingModel(modelId) ? { thinking: true } : {}
          });
        }
      });
      
      // Add thinking capability flag to existing models
      const processedModelIds = new Set();
      const originalModelsData = [...models.data];
      
      models.data = originalModelsData.flatMap((model: any) => {
        const modelId = model.id;
        processedModelIds.add(modelId);
        
        // Apply capabilities to all models
        if (isQwenThinkingModel(modelId)) {
          model.capabilities = model.capabilities || {};
          model.capabilities.thinking = true;
        }
        
        // For Qwen3 models, add thinking and non-thinking variants, but not the original
        if (isQwen3Model(modelId) && 
            !isThinkingVariant(modelId) && 
            !isNonThinkingVariant(modelId)) {
          
          // Create thinking variant
          const thinkingModel = {
            id: `${modelId}-thinking`,
            object: "model",
            created: model.created || Date.now(),
            owned_by: model.owned_by || "qwen",
            capabilities: { thinking: true },
            proxy_managed: true,
            display_name: `${model.display_name || modelId} (Thinking Mode)`
          };
          
          // Create non-thinking variant
          const nonThinkingModel = {
            id: `${modelId}-nonthinking`,
            object: "model",
            created: model.created || Date.now(),
            owned_by: model.owned_by || "qwen",
            capabilities: { thinking: true },
            proxy_managed: true,
            display_name: `${model.display_name || modelId} (Standard Mode)`
          };
          
          // Only add variants, not the original model
          return [thinkingModel, nonThinkingModel];
        }
        
        return [model];
      });
    } else {
      // If the API response didn't include models, create our own list
      models.data = knownQwenModels.flatMap(modelId => {
        // For Qwen3 models, add only thinking and non-thinking variants (not the base model)
        if (isQwen3Model(modelId) && 
            !isThinkingVariant(modelId) && 
            !isNonThinkingVariant(modelId)) {
          
          return [
            {
              id: `${modelId}-thinking`,
              object: "model",
              created: Date.now(),
              owned_by: "qwen",
              capabilities: { thinking: true },
              proxy_managed: true,
              display_name: `${modelId} (Thinking Mode)`
            },
            {
              id: `${modelId}-nonthinking`,
              object: "model",
              created: Date.now(),
              owned_by: "qwen",
              capabilities: { thinking: true },
              proxy_managed: true,
              display_name: `${modelId} (Standard Mode)`
            }
          ];
        }
        
        // For non-Qwen3 models, return the base model
        const baseModel = {
          id: modelId,
          object: "model",
          created: Date.now(),
          owned_by: "qwen",
          capabilities: isQwenThinkingModel(modelId) ? { thinking: true } : {}
        };
        
        return [baseModel];
      });
    }

    log.debug({ modelCount: models.data?.length }, "Retrieved models from Qwen API");

    // Cache the response
    modelsCache = models;
    modelsCacheTime = new Date().getTime();
    return models;
  } catch (error) {
    // Provide detailed logging for better troubleshooting
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error fetching Qwen models"
      );
    } else {
      log.error({ error }, "Unknown error fetching Qwen models");
    }
    
    // Return empty list as fallback
    return {
      object: "list",
      data: [],
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

// Function to prepare messages for Qwen API
function prepareMessages(req: Request) {
  if (req.body.messages && Array.isArray(req.body.messages)) {
    req.body.messages = normalizeMessages(req.body.messages);
  }
}

// Function to handle thinking capability for Qwen models
function handleThinkingCapability(req: Request) {
  const model = req.body.model;
  
  // Special handling for our proxy-managed variants
  if (isThinkingVariant(model)) {
    // Set the base model name without the suffix
    req.body.model = getBaseModelName(model);
    // Force enable thinking for the -thinking variant
    req.body.enable_thinking = true;
    
    // Log the transformation
    log.debug(
      { originalModel: model, transformedModel: req.body.model, enableThinking: true },
      "Transformed request for thinking variant"
    );
    return;
  }
  
  if (isNonThinkingVariant(model)) {
    // Set the base model name without the suffix
    req.body.model = getBaseModelName(model);
    // Force disable thinking for the -nonthinking variant
    req.body.enable_thinking = false;
    
    // Log the transformation
    log.debug(
      { originalModel: model, transformedModel: req.body.model, enableThinking: false },
      "Transformed request for non-thinking variant"
    );
    return;
  }
  
  // For standard models with thinking capability
  if (isQwenThinkingModel(model) && req.body.stream === true) {
    // Only add enable_thinking if it's not already set
    if (req.body.enable_thinking === undefined) {
      req.body.enable_thinking = false; // Default to false, let users explicitly enable it
    }
    
    // If thinking_budget is provided but enable_thinking is false, enable thinking
    if (req.body.thinking_budget !== undefined && req.body.enable_thinking === false) {
      req.body.enable_thinking = true;
    }
  } else if (isQwenThinkingModel(model) && req.body.stream !== true) {
    // For non-streaming requests with thinking-capable models, always disable thinking
    req.body.enable_thinking = false;
  }
}

// Function to remove parameters not supported by Qwen models
function removeUnsupportedParameters(req: Request) {
  // Remove parameters that Qwen doesn't support
  if (req.body.logit_bias !== undefined) {
    delete req.body.logit_bias;
  }
  
  if (req.body.top_logprobs !== undefined) {
    delete req.body.top_logprobs;
  }
  
  // Logging for debugging
  if (process.env.NODE_ENV !== 'production') {
    log.debug({ body: req.body }, "Request after parameter cleanup");
  }
}

// Set up count token functionality for Qwen models
function countQwenTokens(req: Request) {
  const model = req.body.model;
  
  if (isQwenModel(model)) {
    // Count tokens using prompt tokens (simplified)
    if (req.promptTokens) {
      req.log.debug(
        { tokens: req.promptTokens },
        "Estimated token count for Qwen prompt"
      );
    }
  }
}

const qwenProxy = createQueuedProxyMiddleware({
  mutations: [
    addKey,
    finalizeBody
  ],
  target: "https://dashscope-intl.aliyuncs.com/compatible-mode",
  blockingResponseHandler: qwenResponseHandler,
});

const qwenRouter = Router();

qwenRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "qwen" },
    { afterTransform: [ prepareMessages, handleThinkingCapability, removeUnsupportedParameters, countQwenTokens ] }
  ),
  qwenProxy
);

qwenRouter.post(
  "/v1/embeddings",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "qwen" },
    { afterTransform: [] }
  ),
  qwenProxy
);

qwenRouter.get("/v1/models", handleModelRequest);

export const qwen = qwenRouter;
