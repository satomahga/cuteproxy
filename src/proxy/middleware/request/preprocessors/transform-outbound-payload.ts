import { Request } from "express";
import {
  API_REQUEST_VALIDATORS,
  API_REQUEST_TRANSFORMERS,
} from "../../../../shared/api-schemas";
import { BadRequestError } from "../../../../shared/errors";
import { fixMistralPrompt, isMistralVisionModel } from "../../../../shared/api-schemas/mistral-ai";
import {
  isImageGenerationRequest,
  isTextGenerationRequest,
} from "../../common";
import { RequestPreprocessor } from "../index";

/** Transforms an incoming request body to one that matches the target API. */
export const transformOutboundPayload: RequestPreprocessor = async (req) => {
  const alreadyTransformed = req.retryCount > 0;
  const notTransformable =
    !isTextGenerationRequest(req) && !isImageGenerationRequest(req);

  if (alreadyTransformed) {
    return;
  } else if (notTransformable) {
    // This is probably an indication of a bug in the proxy.
    const { inboundApi, outboundApi, method, path } = req;
    req.log.warn(
      { inboundApi, outboundApi, method, path },
      "`transformOutboundPayload` called on a non-transformable request."
    );
    return;
  }

  applyMistralPromptFixes(req);
  applyGoogleAIKeyTransforms(req);
  applyOpenAIResponsesTransform(req);

  // Native prompts are those which were already provided by the client in the
  // target API format. We don't need to transform them.
  const isNativePrompt = req.inboundApi === req.outboundApi;
  if (isNativePrompt) {
    const result = API_REQUEST_VALIDATORS[req.inboundApi].parse(req.body);
    req.body = result;
    return;
  }

  // Prompt requires translation from one API format to another.
  const transformation = `${req.inboundApi}->${req.outboundApi}` as const;
  const transFn = API_REQUEST_TRANSFORMERS[transformation];

  if (transFn) {
    req.log.info({ transformation }, "Transforming request...");
    req.body = await transFn(req);
    return;
  }

  throw new BadRequestError(
    `${transformation} proxying is not supported. Make sure your client is configured to send requests in the correct format and to the correct endpoint.`
  );
};

// Handle OpenAI Responses API transformation
function applyOpenAIResponsesTransform(req: Request): void {
  if (req.outboundApi === "openai-responses") {
    req.log.info("Transforming request to OpenAI Responses API format");

    // Store the original body for reference if needed
    const originalBody = { ...req.body };

    // Map standard OpenAI chat completions format to Responses API format
    // The main differences are:
    // 1. Endpoint is /v1/responses instead of /v1/chat/completions
    // 2. 'messages' field moves to 'input.messages'
    
    // Move messages to input.messages
    if (req.body.messages && !req.body.input) {
      req.body.input = {
        messages: req.body.messages
      };
      delete req.body.messages;
    }
    
    // Keep all the original properties of the request but ensure compatibility
    // with Responses API specifics
    if (!req.body.previousResponseId && req.body.conversation_id) {
      req.body.previousResponseId = req.body.conversation_id;
      delete req.body.conversation_id;
    }

    // Convert max_tokens to max_output_tokens if present and not already set
    if (req.body.max_tokens && !req.body.max_output_tokens) {
      req.body.max_output_tokens = req.body.max_tokens;
      delete req.body.max_tokens;
    }

    // Set the correct tools format if needed
    if (req.body.tools) {
      // Tools structure is maintained but might need conversion if non-standard
      if (!req.body.tools.some((tool: any) => tool.type === "function" || tool.type === "web_search")) {
        req.body.tools = req.body.tools.map((tool: any) => ({
          ...tool,
          type: tool.type || "function"
        }));
      }
    }

    req.log.info({
      originalModel: originalBody.model,
      newFormat: "openai-responses"
    }, "Successfully transformed request to Responses API format");
  }
}

// handles weird cases that don't fit into our abstractions
function applyMistralPromptFixes(req: Request): void {
  if (req.inboundApi === "mistral-ai") {
    // Mistral Chat is very similar to OpenAI but not identical and many clients
    // don't properly handle the differences. We will try to validate the
    // mistral prompt and try to fix it if it fails. It will be re-validated
    // after this function returns.
    const result = API_REQUEST_VALIDATORS["mistral-ai"].parse(req.body);
    
    // Check if this is a vision model request
    const isVisionModel = isMistralVisionModel(req.body.model);
    
    // Check if the request contains image content
    const hasImageContent = result.messages?.some((msg: {content: string | any[]}) => 
      Array.isArray(msg.content) && 
      msg.content.some((item: any) => item.type === "image_url")
    );
    
    // For vision requests, normalize the image_url format
    if (hasImageContent && Array.isArray(result.messages)) {
      // Process each message with image content
      result.messages.forEach((msg: any) => {
        if (Array.isArray(msg.content)) {
          // Process each content item
          msg.content.forEach((item: any) => {
            if (item.type === "image_url") {
              // Normalize the image_url field to a string format that Mistral expects
              if (typeof item.image_url === "object") {
                // If it's an object, extract the URL or base64 data
                if (item.image_url.url) {
                  item.image_url = item.image_url.url;
                } else if (item.image_url.data) {
                  item.image_url = item.image_url.data;
                }
                
                req.log.info(
                  { model: req.body.model },
                  "Normalized object-format image_url to string format"
                );
              }
            }
          });
        }
      });
    }
    
    // Apply Mistral prompt fixes while preserving multimodal content
    req.body.messages = fixMistralPrompt(result.messages);
    req.log.info(
      { 
        n: req.body.messages.length, 
        prev: result.messages.length,
        isVisionModel,
        hasImageContent 
      },
      "Applied Mistral chat prompt fixes."
    );

    // If this is a vision model with image content, it MUST use the chat API
    // and cannot be converted to text completions
    if (hasImageContent) {
      req.log.info(
        { model: req.body.model },
        "Detected Mistral vision request with image content. Keeping as chat format."
      );
      return;
    }

    // If the prompt relies on `prefix: true` for the last message, we need to
    // convert it to a text completions request because AWS Mistral support for
    // this feature is broken.
    // On Mistral La Plateforme, we can't do this because they don't expose
    // a text completions endpoint.
    const { messages } = req.body;
    const lastMessage = messages && messages[messages.length - 1];
    if (lastMessage?.role === "assistant" && req.service === "aws") {
      // enable prefix if client forgot, otherwise the template will insert an
      // eos token which is very unlikely to be what the client wants.
      lastMessage.prefix = true;
      req.outboundApi = "mistral-text";
      req.log.info(
        "Native Mistral chat prompt relies on assistant message prefix. Converting to text completions request."
      );
    }
  }
}

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function transformKeysToCamelCase(obj: any, hasTransformed = { value: false }): any {
  if (Array.isArray(obj)) {
    return obj.map(item => transformKeysToCamelCase(item, hasTransformed));
  }
  
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => {
        const camelKey = toCamelCase(key);
        if (camelKey !== key) {
          hasTransformed.value = true;
        }
        return [
          camelKey,
          transformKeysToCamelCase(value, hasTransformed)
        ];
      })
    );
  }
  
  return obj;
}

function applyGoogleAIKeyTransforms(req: Request): void {
  // Google (Gemini) API in their infinite wisdom accepts both snake_case and camelCase
  // for some params even though in the docs they use snake_case.
  // Some frontends (e.g. ST) use snake_case and camelCase so we normalize all keys to camelCase
  if (req.outboundApi === "google-ai") {
    const hasTransformed = { value: false };
    req.body = transformKeysToCamelCase(req.body, hasTransformed);
    if (hasTransformed.value) {
      req.log.info("Applied Gemini camelCase -> snake_case transform");
    }
  }
}
