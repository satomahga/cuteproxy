import { Request, RequestHandler, Router } from "express";
import { config } from "../config";
import { BadRequestError } from "../shared/errors";
import { AzureOpenAIKey, keyPool, OpenAIKey } from "../shared/key-management";
import { getOpenAIModelFamily } from "../shared/models";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  addKeyForEmbeddingsRequest,
  createEmbeddingsPreprocessorMiddleware,
  createPreprocessorMiddleware,
  finalizeBody,
  RequestPreprocessor,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

// https://platform.openai.com/docs/models/overview
let modelsCache: any = null;
let modelsCacheTime = 0;

export function generateModelList(service: "openai" | "azure") {
  const keys = keyPool
    .list()
    .filter((k) => k.service === service && !k.isDisabled) as
    | OpenAIKey[]
    | AzureOpenAIKey[];
  if (keys.length === 0) return [];

  const allowedModelFamilies = new Set(config.allowedModelFamilies);
  const modelFamilies = new Set(
    keys
      .flatMap((k) => k.modelFamilies)
      .filter((f) => allowedModelFamilies.has(f))
  );

  const modelIds = new Set(
    keys
      .flatMap((k) => k.modelIds)
      .filter((id) => {
        const allowed = modelFamilies.has(getOpenAIModelFamily(id));
        const known = ["gpt", "o", "dall-e", "chatgpt", "text-embedding", "codex"].some(
          (prefix) => id.startsWith(prefix)
        );
        const isFinetune = id.includes("ft");
        return allowed && known && !isFinetune;
      })
  );

  return Array.from(modelIds).map((id) => ({
    id,
    object: "model",
    created: new Date().getTime(),
    owned_by: service,
    permission: [
      {
        id: "modelperm-" + id,
        object: "model_permission",
        created: new Date().getTime(),
        organization: "*",
        group: null,
        is_blocking: false,
      },
    ],
    root: id,
    parent: null,
  }));
}

const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return res.status(200).json(modelsCache);
  }

  if (!config.openaiKey) return { object: "list", data: [] };

  const result = generateModelList("openai");

  modelsCache = { object: "list", data: result };
  modelsCacheTime = new Date().getTime();
  res.status(200).json(modelsCache);
};

/** Handles some turbo-instruct special cases. */
const rewriteForTurboInstruct: RequestPreprocessor = (req) => {
  // /v1/turbo-instruct/v1/chat/completions accepts either prompt or messages.
  // Depending on whichever is provided, we need to set the inbound format so
  // it is transformed correctly later.
  if (req.body.prompt && !req.body.messages) {
    req.inboundApi = "openai-text";
  } else if (req.body.messages && !req.body.prompt) {
    req.inboundApi = "openai";
    // Set model for user since they're using a client which is not aware of
    // turbo-instruct.
    req.body.model = "gpt-3.5-turbo-instruct";
  } else {
    throw new Error("`prompt` OR `messages` must be provided");
  }

  req.url = "/v1/completions";
};

const openaiResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  const interval = (req as any)._keepAliveInterval
  if (interval) {
    clearInterval(interval);
    res.write(JSON.stringify(body));
    res.end();
    return;
  }

  let newBody = body;
  if (req.outboundApi === "openai-text" && req.inboundApi === "openai") {
    req.log.info("Transforming Turbo-Instruct response to Chat format");
    newBody = transformTurboInstructResponse(body);
  } else if (req.outboundApi === "openai-responses" && req.inboundApi === "openai") {
    req.log.info("Transforming Responses API response to Chat format");
    newBody = transformResponsesApiResponse(body);
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

function transformTurboInstructResponse(
  turboInstructBody: Record<string, any>
): Record<string, any> {
  const transformed = { ...turboInstructBody };
  transformed.choices = [
    {
      ...turboInstructBody.choices[0],
      message: {
        role: "assistant",
        content: turboInstructBody.choices[0].text.trim(),
      },
    },
  ];
  delete transformed.choices[0].text;
  return transformed;
}

function transformResponsesApiResponse(
  responsesBody: Record<string, any>
): Record<string, any> {
  // If the response is already in chat completion format, return it as is
  if (responsesBody.choices && responsesBody.choices[0]?.message) {
    return responsesBody;
  }
  
  // Create a compatible format for clients expecting chat completions format
  const transformed: Record<string, any> = {
    id: responsesBody.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: responsesBody.created_at || Math.floor(Date.now() / 1000),
    model: responsesBody.model || "o1-pro",
    choices: [],
    usage: responsesBody.usage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  // Extract content from the Responses API format - multiple possible structures
  
  // Structure 1: output array with message objects
  if (responsesBody.output && Array.isArray(responsesBody.output)) {
    // Look for a message type in the output array
    let messageOutput = null;
    for (const output of responsesBody.output) {
      if (output.type === "message") {
        messageOutput = output;
        break;
      }
    }
    
    if (messageOutput) {
      if (messageOutput.content && Array.isArray(messageOutput.content) && messageOutput.content.length > 0) {
        // Handle text content
        let content = "";
        const toolCalls: any[] = [];
        
        for (const contentItem of messageOutput.content) {
          if (contentItem.type === "output_text") {
            content += contentItem.text;
          } else if (contentItem.type === "tool_calls" && Array.isArray(contentItem.tool_calls)) {
            toolCalls.push(...contentItem.tool_calls);
          }
        }
        
        const message: Record<string, any> = {
          role: messageOutput.role || "assistant",
          content: content
        };
        
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }
        
        transformed.choices.push({
          index: 0,
          message,
          finish_reason: "stop"
        });
      } else if (typeof messageOutput.content === 'string') {
        // Simple string content
        transformed.choices.push({
          index: 0,
          message: {
            role: messageOutput.role || "assistant",
            content: messageOutput.content
          },
          finish_reason: "stop"
        });
      }
    }
  }
  
  // Structure 2: response object with content
  else if (responsesBody.response && responsesBody.response.content) {
    transformed.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: typeof responsesBody.response.content === 'string' 
          ? responsesBody.response.content 
          : JSON.stringify(responsesBody.response.content)
      },
      finish_reason: responsesBody.response.finish_reason || "stop"
    });
  }
  
  // Structure 3: look for 'content' field directly
  else if (responsesBody.content) {
    transformed.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: typeof responsesBody.content === 'string' 
          ? responsesBody.content 
          : JSON.stringify(responsesBody.content)
      },
      finish_reason: "stop"
    });
  }
  
  // If we couldn't extract content, create a basic response
  if (transformed.choices.length === 0) {
    transformed.choices.push({
      index: 0,
      message: {
        role: "assistant",
        content: ""
      },
      finish_reason: "stop"
    });
  }
  
  // Copy usage information if available
  if (responsesBody.usage) {
    transformed.usage = {
      prompt_tokens: responsesBody.usage.input_tokens || 0,
      completion_tokens: responsesBody.usage.output_tokens || 0,
      total_tokens: responsesBody.usage.total_tokens || 0
    };
  }
  
  return transformed;
}

const openaiProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://api.openai.com",
  blockingResponseHandler: openaiResponseHandler,
});

const openaiEmbeddingsProxy = createQueuedProxyMiddleware({
  mutations: [addKeyForEmbeddingsRequest, finalizeBody],
  target: "https://api.openai.com",
});

// New proxy middleware for the Responses API
const openaiResponsesProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://api.openai.com",
  blockingResponseHandler: openaiResponseHandler,
});

const openaiRouter = Router();
openaiRouter.get("/v1/models", handleModelRequest);
// Native text completion endpoint, only for turbo-instruct.
openaiRouter.post(
  "/v1/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-text",
    outApi: "openai-text",
    service: "openai",
  }),
  openaiProxy
);
// turbo-instruct compatibility endpoint, accepts either prompt or messages
openaiRouter.post(
  /\/v1\/turbo-instruct\/(v1\/)?chat\/completions/,
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai-text", service: "openai" },
    {
      beforeTransform: [rewriteForTurboInstruct],
      afterTransform: [forceModel("gpt-3.5-turbo-instruct")],
    }
  ),
  openaiProxy
);

const setupChunkedTransfer: RequestHandler = (req, res, next) => {
  req.log.info("Setting chunked transfer for o1 to prevent Cloudflare timeouts")
  
  // Check if user is trying to use streaming with codex-mini models
  if (req.body.model?.startsWith("codex-mini") && req.body.stream === true) {
    return res.status(400).json({
      error: {
        message: "The codex-mini models do not support streaming. Please set 'stream: false' in your request.",
        type: "invalid_request_error",
        param: "stream",
        code: "streaming_not_supported"
      }
    });
  }
  
  // Only o1 doesn't support streaming
  if (req.body.model === "o1" || req.body.model === "o1-2024-12-17") {
    req.isChunkedTransfer = true;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked'
    });
    
    // Higher values are required - otherwise Cloudflare will buffer and not pass
    // the separate chunks, which means that a >100s response will get terminated anyway
    const keepAlive = setInterval(() => {
      res.write(' '.repeat(4096));
    }, 48_000);
    
    (req as any)._keepAliveInterval = keepAlive;
  }
  next();
};

// Functions to handle model-specific API routing
function shouldUseResponsesApi(model: string): boolean {
  return model === "o1-pro" || model.startsWith("o1-pro-") ||
         model === "o3-pro" || model.startsWith("o3-pro-") || 
         model === "codex-mini-latest" || model.startsWith("codex-mini-");
}

// Preprocessor to redirect requests to the responses API
const routeToResponsesApi: RequestPreprocessor = (req) => {
  if (shouldUseResponsesApi(req.body.model)) {
    req.log.info(`Routing ${req.body.model} to OpenAI Responses API`);
    req.url = "/v1/responses";
    req.outboundApi = "openai-responses";
  }
};

// General chat completion endpoint. Turbo-instruct is not supported here.
openaiRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "openai" },
    { 
      afterTransform: [
        fixupMaxTokens, 
        filterGPT5UnsupportedParams,
        routeToResponsesApi
      ] 
    }
  ),
  setupChunkedTransfer,
  (req, _res, next) => {
    // Route to the responses endpoint if needed
    if (req.outboundApi === "openai-responses") {
      // Ensure messages is moved to input properly
      req.log.info("Final check for Responses API format in chat completions");
      if (req.body.messages) {
        req.log.info("Moving 'messages' to 'input' for Responses API");
        req.body.input = req.body.messages;
        delete req.body.messages;
      } else if (req.body.input && req.body.input.messages) {
        req.log.info("Reformatting input.messages for Responses API");
        req.body.input = req.body.input.messages;
      }
      
      return openaiResponsesProxy(req, _res, next);
    }
    next();
  },
  openaiProxy
);

// New endpoint for OpenAI Responses API
openaiRouter.post(
  "/v1/responses",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai-responses", service: "openai" },
    { afterTransform: [fixupMaxTokens, filterGPT5UnsupportedParams] }
  ),
  // Add final check to ensure the body is in the correct format for Responses API
  (req, _res, next) => {
    req.log.info("Final check for Responses API format");
    
    // Ensure messages is properly formatted for input
    if (req.body.messages) {
      req.log.info("Moving 'messages' to 'input' for Responses API");
      req.body.input = req.body.messages;
      delete req.body.messages;
    } else if (req.body.input && req.body.input.messages) {
      req.log.info("Reformatting input.messages for Responses API");
      req.body.input = req.body.input.messages;
    }
    
    next();
  },
  openaiResponsesProxy
);

// Embeddings endpoint.
openaiRouter.post(
  "/v1/embeddings",
  ipLimiter,
  createEmbeddingsPreprocessorMiddleware(),
  openaiEmbeddingsProxy
);

function forceModel(model: string): RequestPreprocessor {
  return (req: Request) => void (req.body.model = model);
}

function fixupMaxTokens(req: Request) {
  // For Responses API, use max_output_tokens instead of max_completion_tokens
  if (req.outboundApi === "openai-responses") {
    if (!req.body.max_output_tokens) {
      req.body.max_output_tokens = req.body.max_tokens || req.body.max_completion_tokens;
    }
    // Remove the other token params to avoid API errors
    delete req.body.max_tokens;
    delete req.body.max_completion_tokens;
    
    // Remove other parameters not supported by Responses API
    const unsupportedParams = ['frequency_penalty', 'presence_penalty'];
    for (const param of unsupportedParams) {
      if (req.body[param] !== undefined) {
        req.log.info(`Removing unsupported parameter for Responses API: ${param}`);
        delete req.body[param];
      }
    }
  } else {
    // Original behavior for other APIs
    if (!req.body.max_completion_tokens) {
      req.body.max_completion_tokens = req.body.max_tokens;
    }
    delete req.body.max_tokens;
  }
}

// GPT-5, GPT-5-mini, and GPT-5-nano don't support certain parameters
// Remove them if present to prevent API errors
function filterGPT5UnsupportedParams(req: Request) {
  const model = req.body.model;
  
  // Only apply filtering to these specific models (gpt5-chat-latest supports all params)
  const restrictedModels = /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/;
  
  if (!restrictedModels.test(model)) {
    return; // Not a restricted model, no filtering needed
  }
  
  // Remove unsupported parameters if they exist
  const unsupportedParams = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'];
  
  for (const param of unsupportedParams) {
    if (req.body[param] !== undefined) {
      delete req.body[param];
    }
  }
}


export const openai = openaiRouter;
