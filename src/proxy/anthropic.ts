import { Request, RequestHandler, Router } from "express";
import { config } from "../config";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";
import { claudeModels } from "../shared/claude-models";
import { validateClaude41OpusParameters } from "../shared/claude-4-1-validation";

let modelsCache: any = null;
let modelsCacheTime = 0;

const getModelsResponse = () => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  if (!config.anthropicKey) return { object: "list", data: [], has_more: false, first_id: null, last_id: null };

  const date = new Date()
  const models = claudeModels.map(model => ({
    // Common
    id: model.anthropicId,
    owned_by: "anthropic",
    // Anthropic
    type: "model",
    display_name: model.displayName,
    created_at: date.toISOString(),
    // OpenAI
    object: "model",
    created: date.getTime(),
  }));  

  modelsCache = { 
    // Common
    object: "list",
    data: models,
    // Anthropic
    has_more: false,
    first_id: models[0]?.id,
    last_id: models[models.length - 1]?.id,
  };
  modelsCacheTime = date.getTime();

  return modelsCache;
};

const handleModelRequest: RequestHandler = (_req, res) => {
  res.status(200).json(getModelsResponse());
};

const anthropicBlockingResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  switch (`${req.inboundApi}<-${req.outboundApi}`) {
    case "openai<-anthropic-text":
      req.log.info("Transforming Anthropic Text back to OpenAI format");
      newBody = transformAnthropicTextResponseToOpenAI(body, req);
      break;
    case "openai<-anthropic-chat":
      req.log.info("Transforming Anthropic Chat back to OpenAI format");
      newBody = transformAnthropicChatResponseToOpenAI(body);
      break;
    case "anthropic-text<-anthropic-chat":
      req.log.info("Transforming Anthropic Chat back to Anthropic chat format");
      newBody = transformAnthropicChatResponseToAnthropicText(body);
      break;
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

function flattenChatResponse(
  content: { type: string; text: string }[]
): string {
  return content
    .map((part: { type: string; text: string }) =>
      part.type === "text" ? part.text : ""
    )
    .join("\n");
}

export function transformAnthropicChatResponseToAnthropicText(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    type: "completion",
    id: "ant-" + anthropicBody.id,
    completion: flattenChatResponse(anthropicBody.content),
    stop_reason: anthropicBody.stop_reason,
    stop: anthropicBody.stop_sequence,
    model: anthropicBody.model,
    usage: anthropicBody.usage,
  };
}

function transformAnthropicTextResponseToOpenAI(
  anthropicBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "ant-" + anthropicBody.log_id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: anthropicBody.completion?.trim(),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}

export function transformAnthropicChatResponseToOpenAI(
  anthropicBody: Record<string, any>
): Record<string, any> {
  return {
    id: "ant-" + anthropicBody.id,
    object: "chat.completion",
    created: Date.now(),
    model: anthropicBody.model,
    usage: anthropicBody.usage,
    choices: [
      {
        message: {
          role: "assistant",
          content: flattenChatResponse(anthropicBody.content),
        },
        finish_reason: anthropicBody.stop_reason,
        index: 0,
      },
    ],
  };
}

/**
 * If a client using the OpenAI compatibility endpoint requests an actual OpenAI
 * model, reassigns it to Sonnet.
 */
function maybeReassignModel(req: Request) {
  const model = req.body.model;
  if (model.includes("claude")) return; // use whatever model the user requested
  req.body.model = "claude-3-5-sonnet-latest";
}

/**
 * If client requests more than 4096 output tokens the request must have a
 * particular version header.
 * https://docs.anthropic.com/en/release-notes/api#july-15th-2024
 * 
 * Also adds the required beta header for 1-hour cache duration if requested.
 * Also adds the 1M context beta header for Claude Sonnet 4 if context > 200k tokens.
 * Also validates Claude 4.1 Opus parameters (temperature/top_p).
 */
function setAnthropicBetaHeader(req: Request) {
  // Validate Claude 4.1 Opus parameters before processing
  validateClaude41OpusParameters(req);
  
  const { max_tokens_to_sample } = req.body;
  const model = req.body.model;
  
  // Initialize beta headers array
  const betaHeaders: string[] = [];
  
  // Add max tokens beta header if needed
  if (max_tokens_to_sample > 4096) {
    betaHeaders.push("max-tokens-3-5-sonnet-2024-07-15");
  }
  
  // Add extended cache TTL beta header if 1h cache is requested
  if (req.body.cache_control?.ttl === "1h") {
    betaHeaders.push("extended-cache-ttl-2025-04-11");
  }
  
  // Add 1M context beta header for Claude Sonnet 4 if context > 200k tokens
  if (model?.includes("claude-sonnet-4") && req.promptTokens && req.outputTokens) {
    const contextTokens = req.promptTokens + req.outputTokens;
    if (contextTokens > 200000) {
      betaHeaders.push("context-1m-2025-08-07");
    }
  }
  
  // Set the combined beta headers if any were added
  if (betaHeaders.length > 0) {
    req.headers["anthropic-beta"] = betaHeaders.join(",");
  }
}

/**
 * Adds web search tool for Claude-3.5 and Claude-3.7 models when enable_web_search is true
 * 
 * Supports all optional parameters documented in the Claude API:
 * - max_uses: Limit the number of searches per request
 * - allowed_domains: Only include results from these domains
 * - blocked_domains: Never include results from these domains
 * - user_location: Localize search results
 */
function addWebSearchTool(req: Request) {
  // Check if this is a Claude model that supports web search and if web search is enabled
  const isClaude35 = req.body.model?.includes("claude-3-5") || req.body.model?.includes("claude-3.5");
  const isClaude37 = req.body.model?.includes("claude-3-7") || req.body.model?.includes("claude-3.7");
  const isClaude4 = req.body.model?.includes("claude-sonnet-4") || req.body.model?.includes("claude-opus-4");
  const useWebSearch = (isClaude35 || isClaude37 || isClaude4) && Boolean(req.body.enable_web_search);
  
  if (useWebSearch) {
    // Create the base web search tool
    const webSearchTool: any = {
      'type': 'web_search_20250305',
      'name': 'web_search',
    };
    
    // Add optional parameters if provided by the client
    
    // max_uses: Limit the number of searches per request
    if (typeof req.body.web_search_max_uses === 'number') {
      webSearchTool.max_uses = req.body.web_search_max_uses;
      delete req.body.web_search_max_uses;
    }
    
    // allowed_domains: Only include results from these domains
    if (Array.isArray(req.body.web_search_allowed_domains)) {
      webSearchTool.allowed_domains = req.body.web_search_allowed_domains;
      delete req.body.web_search_allowed_domains;
    }
    
    // blocked_domains: Never include results from these domains
    if (Array.isArray(req.body.web_search_blocked_domains)) {
      webSearchTool.blocked_domains = req.body.web_search_blocked_domains;
      delete req.body.web_search_blocked_domains;
    }
    
    // user_location: Localize search results
    if (req.body.web_search_user_location) {
      webSearchTool.user_location = req.body.web_search_user_location;
      delete req.body.web_search_user_location;
    }
    
    // Add the web search tool to the tools array
    req.body.tools = [...(req.body.tools || []), webSearchTool];
  }
  
  // Delete custom parameters as they're not standard Claude API parameters
  delete req.body.enable_web_search;
  delete req.body.reasoning_effort;
}

function selectUpstreamPath(manager: ProxyReqManager) {
  const req = manager.request;
  const pathname = req.url.split("?")[0];
  req.log.debug({ pathname }, "Anthropic path filter");
  const isText = req.outboundApi === "anthropic-text";
  const isChat = req.outboundApi === "anthropic-chat";
  if (isChat && pathname === "/v1/complete") {
    manager.setPath("/v1/messages");
  }
  if (isText && pathname === "/v1/chat/completions") {
    manager.setPath("/v1/complete");
  }
  if (isChat && pathname === "/v1/chat/completions") {
    manager.setPath("/v1/messages");
  }
  if (isChat && ["sonnet", "opus"].includes(req.params.type)) {
    manager.setPath("/v1/messages");
  }
}

const anthropicProxy = createQueuedProxyMiddleware({
  target: "https://api.anthropic.com",
  mutations: [selectUpstreamPath, addKey, finalizeBody],
  blockingResponseHandler: anthropicBlockingResponseHandler,
});

const nativeAnthropicChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-chat", outApi: "anthropic-chat", service: "anthropic" },
  { afterTransform: [setAnthropicBetaHeader, addWebSearchTool] }
);

const nativeTextPreprocessor = createPreprocessorMiddleware(
  {
    inApi: "anthropic-text",
    outApi: "anthropic-text",
    service: "anthropic",
  },
  { afterTransform: [setAnthropicBetaHeader, addWebSearchTool] }
);

const textToChatPreprocessor = createPreprocessorMiddleware(
  {
    inApi: "anthropic-text",
    outApi: "anthropic-chat",
    service: "anthropic",
  },
  { afterTransform: [setAnthropicBetaHeader, addWebSearchTool] }
);

/**
 * Routes text completion prompts to anthropic-chat if they need translation
 * (claude-3 based models do not support the old text completion endpoint).
 */
const preprocessAnthropicTextRequest: RequestHandler = (req, res, next) => {
  const model = req.body.model;
  const isClaude4Model = model?.includes("claude-sonnet-4") || model?.includes("claude-opus-4");
  if (model?.startsWith("claude-3") || isClaude4Model) {
    textToChatPreprocessor(req, res, next);
  } else {
    nativeTextPreprocessor(req, res, next);
  }
};

const oaiToTextPreprocessor = createPreprocessorMiddleware(
  {
    inApi: "openai",
    outApi: "anthropic-text",
    service: "anthropic",
  },
  { afterTransform: [setAnthropicBetaHeader] }
);

const oaiToChatPreprocessor = createPreprocessorMiddleware(
  {
    inApi: "openai",
    outApi: "anthropic-chat",
    service: "anthropic",
  },
  { afterTransform: [setAnthropicBetaHeader, addWebSearchTool] }
);

/**
 * Routes an OpenAI prompt to either the legacy Claude text completion endpoint
 * or the new Claude chat completion endpoint, based on the requested model.
 */
const preprocessOpenAICompatRequest: RequestHandler = (req, res, next) => {
  maybeReassignModel(req);
  const model = req.body.model;
  const isClaude4 = model?.includes("claude-sonnet-4") || model?.includes("claude-opus-4");
  if (model?.includes("claude-3") || isClaude4) {
    oaiToChatPreprocessor(req, res, next);
  } else {
    oaiToTextPreprocessor(req, res, next);
  }
};

const anthropicRouter = Router();
anthropicRouter.get("/v1/models", handleModelRequest);
// Native Anthropic chat completion endpoint.
anthropicRouter.post(
  "/v1/messages",
  ipLimiter,
  nativeAnthropicChatPreprocessor,
  anthropicProxy
);
// Anthropic text completion endpoint. Translates to Anthropic chat completion
// if the requested model is a Claude 3 model.
anthropicRouter.post(
  "/v1/complete",
  ipLimiter,
  preprocessAnthropicTextRequest,
  anthropicProxy
);
// OpenAI-to-Anthropic compatibility endpoint. Accepts an OpenAI chat completion
// request and transforms/routes it to the appropriate Anthropic format and
// endpoint based on the requested model.
anthropicRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  preprocessOpenAICompatRequest,
  anthropicProxy
);

export const anthropic = anthropicRouter;
