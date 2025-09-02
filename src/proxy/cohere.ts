import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { CohereKey, keyPool } from "../shared/key-management";
import { isCohereModel, normalizeMessages } from "../shared/api-schemas/cohere";
import { logger } from "../logger";

const log = logger.child({ module: "proxy", service: "cohere" });
let modelsCache: any = null;
let modelsCacheTime = 0;

const cohereResponseHandler: ProxyResHandlerWithBody = async (
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
    // Get a Cohere key directly
    const modelToUse = "command"; // Use any Cohere model here - just for key selection
    const cohereKey = keyPool.get(modelToUse, "cohere") as CohereKey;
    
    if (!cohereKey || !cohereKey.key) {
      log.warn("No valid Cohere key available for model listing");
      throw new Error("No valid Cohere API key available");
    }

    // Fetch models directly from Cohere API
    const response = await axios.get("https://api.cohere.com/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cohereKey.key}`,
        "Cohere-Version": "2022-12-06"
      },
    });

    if (!response.data || !response.data.models) {
      throw new Error("Unexpected response format from Cohere API");
    }

    // Extract models and filter by those that support the chat endpoint
    const filteredModels = response.data.models
      .filter((model: any) => {
        return model.endpoints && model.endpoints.includes("chat");
      })
      .map((model: any) => ({
        id: model.name,
        name: model.name,
        // Adding additional OpenAI-compatible fields
        context_window: model.context_window_size || 4096,
        max_tokens: model.max_tokens || 4096
      }));

    log.debug({ modelCount: filteredModels.length, models: filteredModels.map((m: any) => m.id) }, "Filtered models from Cohere API");

    // Format response to ensure OpenAI compatibility
    const models = {
      object: "list",
      data: filteredModels.map((model: any) => ({
        id: model.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "cohere",
        permission: [],
        root: model.id,
        parent: null,
        context_length: model.context_window,
      })),
    };

    log.debug({ modelCount: filteredModels.length }, "Retrieved models from Cohere API");

    // Cache the response
    modelsCache = models;
    modelsCacheTime = new Date().getTime();
    return models;
  } catch (error) {
    // Provide detailed logging for better troubleshooting
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error fetching Cohere models"
      );
    } else {
      log.error({ error }, "Unknown error fetching Cohere models");
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

// Function to prepare messages for Cohere API
function prepareMessages(req: Request) {
  if (req.body.messages && Array.isArray(req.body.messages)) {
    req.body.messages = normalizeMessages(req.body.messages);
  }
}

// Function to remove parameters not supported by Cohere models
function removeUnsupportedParameters(req: Request) {
  const model = req.body.model;
  
  // Remove parameters that Cohere doesn't support
  if (req.body.logit_bias !== undefined) {
    delete req.body.logit_bias;
  }
  
  if (req.body.top_logprobs !== undefined) {
    delete req.body.top_logprobs;
  }
  
  if (req.body.max_completion_tokens !== undefined) {
    delete req.body.max_completion_tokens;
  }
  
  // Handle structured output format
  if (req.body.response_format && req.body.response_format.schema) {
    // Transform to Cohere's format if needed
    const jsonSchema = req.body.response_format.schema;
    req.body.response_format = {
      type: "json_object",
      schema: jsonSchema
    };
  }

  // Logging for debugging
  if (process.env.NODE_ENV !== 'production') {
    log.debug({ body: req.body }, "Request after parameter cleanup");
  }
}

// Set up count token functionality for Cohere models
function countCohereTokens(req: Request) {
  const model = req.body.model;
  
  if (isCohereModel(model)) {
    // Count tokens using prompt tokens (simplified)
    if (req.promptTokens) {
      req.log.debug(
        { tokens: req.promptTokens },
        "Estimated token count for Cohere prompt"
      );
    }
  }
}

const cohereProxy = createQueuedProxyMiddleware({
  mutations: [
    addKey,
    // Add Cohere-Version header to every request
    (manager) => {
      manager.setHeader("Cohere-Version", "2022-12-06");
    },
    finalizeBody
  ],
  target: "https://api.cohere.ai/compatibility",
  blockingResponseHandler: cohereResponseHandler,
});

const cohereRouter = Router();

cohereRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "cohere" },
    { afterTransform: [ prepareMessages, removeUnsupportedParameters, countCohereTokens ] }
  ),
  cohereProxy
);

cohereRouter.post(
  "/v1/embeddings",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "cohere" },
    { afterTransform: [] }
  ),
  cohereProxy
);

cohereRouter.get("/v1/models", handleModelRequest);

export const cohere = cohereRouter;
