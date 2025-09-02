import { Request, RequestHandler, Router } from "express";
import { v4 } from "uuid";
import {
  transformAnthropicChatResponseToAnthropicText,
  transformAnthropicChatResponseToOpenAI,
} from "./anthropic";
import { ipLimiter } from "./rate-limit";
import {
  createPreprocessorMiddleware,
  finalizeSignedRequest,
  signAwsRequest,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";
import { validateClaude41OpusParameters } from "../shared/claude-4-1-validation";

const awsBlockingResponseHandler: ProxyResHandlerWithBody = async (
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
      newBody = transformAwsTextResponseToOpenAI(body, req);
      break;
    case "openai<-anthropic-chat":
      req.log.info("Transforming AWS Anthropic Chat back to OpenAI format");
      newBody = transformAnthropicChatResponseToOpenAI(body);
      break;
    case "anthropic-text<-anthropic-chat":
      req.log.info("Transforming AWS Anthropic Chat back to Text format");
      newBody = transformAnthropicChatResponseToAnthropicText(body);
      break;
  }

  // AWS does not always confirm the model in the response, so we have to add it
  if (!newBody.model && req.body.model) {
    newBody.model = req.body.model;
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

function transformAwsTextResponseToOpenAI(
  awsBody: Record<string, any>,
  req: Request
): Record<string, any> {
  const totalTokens = (req.promptTokens ?? 0) + (req.outputTokens ?? 0);
  return {
    id: "aws-" + v4(),
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage: {
      prompt_tokens: req.promptTokens,
      completion_tokens: req.outputTokens,
      total_tokens: totalTokens,
    },
    choices: [
      {
        message: {
          role: "assistant",
          content: awsBody.completion?.trim(),
        },
        finish_reason: awsBody.stop_reason,
        index: 0,
      },
    ],
  };
}

const awsClaudeProxy = createQueuedProxyMiddleware({
  target: ({ signedRequest }) => {
    if (!signedRequest) throw new Error("Must sign request before proxying");
    return `${signedRequest.protocol}//${signedRequest.hostname}`;
  },
  mutations: [signAwsRequest, finalizeSignedRequest],
  blockingResponseHandler: awsBlockingResponseHandler,
});

const nativeTextPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-text", outApi: "anthropic-text", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

const textToChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "anthropic-text", outApi: "anthropic-chat", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

/**
 * Routes text completion prompts to aws anthropic-chat if they need translation
 * (claude-3 based models do not support the old text completion endpoint).
 */
const preprocessAwsTextRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.includes("claude-3")) {
    textToChatPreprocessor(req, res, next);
  } else {
    nativeTextPreprocessor(req, res, next);
  }
};

const oaiToAwsTextPreprocessor = createPreprocessorMiddleware(
  { inApi: "openai", outApi: "anthropic-text", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

const oaiToAwsChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "openai", outApi: "anthropic-chat", service: "aws" },
  { afterTransform: [maybeReassignModel] }
);

/**
 * Routes an OpenAI prompt to either the legacy Claude text completion endpoint
 * or the new Claude chat completion endpoint, based on the requested model.
 */
const preprocessOpenAICompatRequest: RequestHandler = (req, res, next) => {
  if (req.body.model?.includes("claude-3")) {
    oaiToAwsChatPreprocessor(req, res, next);
  } else {
    oaiToAwsTextPreprocessor(req, res, next);
  }
};

const awsClaudeRouter = Router();
// Native(ish) Anthropic text completion endpoint.
awsClaudeRouter.post(
  "/v1/complete",
  ipLimiter,
  preprocessAwsTextRequest,
  awsClaudeProxy
);
// Native Anthropic chat completion endpoint.
awsClaudeRouter.post(
  "/v1/messages",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "anthropic-chat", outApi: "anthropic-chat", service: "aws" },
    { afterTransform: [maybeReassignModel] }
  ),
  awsClaudeProxy
);

// OpenAI-to-AWS Anthropic compatibility endpoint.
awsClaudeRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  preprocessOpenAICompatRequest,
  awsClaudeProxy
);

/**
 * Tries to deal with:
 * - frontends sending AWS model names even when they want to use the OpenAI-
 *   compatible endpoint
 * - frontends sending Anthropic model names that AWS doesn't recognize
 * - frontends sending OpenAI model names because they expect the proxy to
 *   translate them
 *
 * If client sends AWS model ID it will be used verbatim. Otherwise, various
 * strategies are used to try to map a non-AWS model name to AWS model ID.
 */
function maybeReassignModel(req: Request) {
  // Validate Claude 4.1 Opus parameters before processing
  validateClaude41OpusParameters(req);
  
  const model = req.body.model;

  // If it looks like an AWS model, use it as-is
  if (model.includes("anthropic.claude")) {
    return;
  }

  // Anthropic model names can look like:
  // - claude-v1
  // - claude-2.1
  // - claude-3-5-sonnet-20240620 (old format: number-model)
  // - claude-3-opus-latest (old format: number-model)
  // - claude-sonnet-4-20250514 (new format: model-number)
  // - claude-opus-4-latest (new format: model-number)
  // - anthropic.claude-3-sonnet-20240229-v1:0 (AWS format with old naming)
  // - anthropic.claude-sonnet-4-20250514-v1:0 (AWS format with new naming)
  const pattern =
    /^(?:anthropic\.)?claude-(?:(?:(instant-)?(v)?(\d+)([.-](\d))?(-\d+k)?(-sonnet-|-opus-|-haiku-)?(latest|\d*))|(?:(sonnet-|opus-|haiku-)(\d+)([.-](\d))?(-\d+k)?-(latest|\d+)))(?:-v\d+(?::\d+)?)?$/i;
  const match = model.match(pattern);

  if (!match) {
    throw new Error(`Provided model name (${model}) doesn't resemble a Claude model ID.`);
  }

  // Check which format matched (old or new)
  // New format: claude-sonnet-4-20250514 or anthropic.claude-sonnet-4-20250514-v1:0
  // Old format: claude-3-sonnet-20240229 or anthropic.claude-3-sonnet-20240229-v1:0
  const isNewFormat = !!match[9];
  
  let major, minor, name, rev;
  
  if (isNewFormat) {
    // New format: claude-sonnet-4-20250514
    // match[9] = sonnet-/opus-/haiku-
    // match[10] = 4 (major version)
    // match[12] = minor version (if any, from [.-](\d) pattern)
    // match[14] = revision (latest or date)
    const modelType = match[9]?.match(/([a-z]+)/)?.[1] || "";
    name = modelType;
    major = match[10];
    minor = match[12];
    rev = match[14];
    
    // Special case: if revision is a single digit and no minor version,
    // treat revision as minor version (e.g., claude-opus-4-1 -> version 4.1)
    if (!minor && rev && /^\d$/.test(rev)) {
      minor = rev;
      rev = undefined;
    }
    
    // Handle instant case for completeness
    const instant = match[1];
    if (instant) {
      req.body.model = "anthropic.claude-instant-v1";
      return;
    }
  } else {
    // Old format: claude-3-sonnet-20240229
    // match[1] = instant- (if any)
    // match[3] = 3 (major version)
    // match[5] = minor version (if any)
    // match[7] = -sonnet-/-opus-/-haiku- (if any)
    // match[8] = revision (latest or date)
    const instant = match[1];
    if (instant) {
      req.body.model = "anthropic.claude-instant-v1";
      return;
    }
    
    major = match[3];
    minor = match[5];
    name = match[7]?.match(/([a-z]+)/)?.[1] || "";
    rev = match[8];
  }

  const ver = minor ? `${major}.${minor}` : major;

  switch (ver) {
    case "1":
    case "1.0":
      req.body.model = "anthropic.claude-v1";
      return;
    case "2":
    case "2.0":
      req.body.model = "anthropic.claude-v2";
      return;
    case "2.1":
      req.body.model = "anthropic.claude-v2:1";
      return;
    case "3":
    case "3.0":
      // there is only one snapshot for all Claude 3 models so there is no need
      // to check the revision
      switch (name) {
        case "sonnet":
          req.body.model = "anthropic.claude-3-sonnet-20240229-v1:0";
          return;
        case "haiku":
          req.body.model = "anthropic.claude-3-haiku-20240307-v1:0";
          return;
        case "opus":
          req.body.model = "anthropic.claude-3-opus-20240229-v1:0";
          return;
      }
      break;
    case "3.5":
      switch (name) {
        case "sonnet":
          switch (rev) {
            case "20241022":
            case "latest":
              req.body.model = "anthropic.claude-3-5-sonnet-20241022-v2:0";
              return;
            case "20240620":
              req.body.model = "anthropic.claude-3-5-sonnet-20240620-v1:0";
              return;
          }
          break;
        case "haiku":
          switch (rev) {
            case "20241022":
            case "latest":
              req.body.model = "anthropic.claude-3-5-haiku-20241022-v1:0";
              return;
          }
        case "opus":
          // Add after model id is announced never
          break;
      }
    case "3.7":
      switch (name) {
        case "sonnet":
          req.body.model = "anthropic.claude-3-7-sonnet-20250219-v1:0";
          return;
      }
      break;
    case "4":
    case "4.0":
      // Mapping "claude-4-..." variants to their actual AWS Bedrock IDs
      // as defined in src/shared/claude-models.ts.
      switch (name) {
        case "sonnet":
          req.body.model = "anthropic.claude-sonnet-4-20250514-v1:0";
          return;
        case "opus":
          req.body.model = "anthropic.claude-opus-4-20250514-v1:0";
          return;
        // No case for "haiku" here, as "claude-4-haiku" is not defined
        // in claude-models.ts. It will fall through and throw an error.
      }
      break;
    case "4.1":
      // Mapping "claude-4.1-..." variants to their actual AWS Bedrock IDs
      // as defined in src/shared/claude-models.ts.
      switch (name) {
        case "opus":
          req.body.model = "anthropic.claude-opus-4-1-20250805-v1:0";
          return;
        // No sonnet or haiku variants for 4.1 yet
      }
      break;
  }

  throw new Error(`Provided model name (${model}) could not be mapped to a known AWS Claude model ID.`);
}

export const awsClaude = awsClaudeRouter;
