import { RequestPreprocessor } from "../index";
import { countTokens } from "../../../../shared/tokenization";
import { assertNever } from "../../../../shared/utils";
import { OpenAIChatMessage } from "../../../../shared/api-schemas";
import { GoogleAIChatMessage } from "../../../../shared/api-schemas/google-ai";
import {
  AnthropicChatMessage,
  flattenAnthropicMessages,
} from "../../../../shared/api-schemas/anthropic";
import { 
  MistralAIChatMessage, 
  ContentItem,
  isMistralVisionModel 
} from "../../../../shared/api-schemas/mistral-ai";
import { isGrokVisionModel } from "../../../../shared/api-schemas/xai";

/**
 * Given a request with an already-transformed body, counts the number of
 * tokens and assigns the count to the request.
 */
export const countPromptTokens: RequestPreprocessor = async (req) => {
  const service = req.outboundApi;
  let result;

  switch (service) {
    case "openai": {
      req.outputTokens = req.body.max_completion_tokens || req.body.max_tokens;
      const prompt: OpenAIChatMessage[] = req.body.messages;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "openai-responses": {
      req.outputTokens = req.body.max_completion_tokens || req.body.max_tokens;
      const prompt: OpenAIChatMessage[] = req.body.messages;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "openai-text": {
      req.outputTokens = req.body.max_tokens;
      const prompt: string = req.body.prompt;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "anthropic-chat": {
      req.outputTokens = req.body.max_tokens;
      let system = req.body.system ?? "";
      if (Array.isArray(system)) {
        system = system
          .map((m: { type: string; text: string }) => m.text)
          .join("\n");
      }
      const prompt = { system, messages: req.body.messages };
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "anthropic-text": {
      req.outputTokens = req.body.max_tokens_to_sample;
      const prompt: string = req.body.prompt;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "google-ai": {
      req.outputTokens = req.body.generationConfig.maxOutputTokens;
      const prompt: GoogleAIChatMessage[] = req.body.contents;
      result = await countTokens({ req, prompt, service });
      break;
    }
    case "mistral-ai":
    case "mistral-text": {
      req.outputTokens = req.body.max_tokens;
      
      // Handle multimodal content (vision) in Mistral models
      const isVisionModel = isMistralVisionModel(req.body.model);
      const messages = req.body.messages;
      
      // Check if this is a vision request with images
      const hasImageContent = Array.isArray(messages) && messages.some(
        (msg: MistralAIChatMessage) => Array.isArray(msg.content) && 
          msg.content.some((item: ContentItem) => item.type === "image_url")
      );
      
      // For vision content, we add a fixed token count per image
      // This is an estimate as the actual token count depends on image size and complexity
      const TOKENS_PER_IMAGE = 1200; // Conservative estimate
      let imageTokens = 0;
      
      if (hasImageContent && Array.isArray(messages)) {
        // Count images in the request
        for (const msg of messages) {
          if (Array.isArray(msg.content)) {
            const imageCount = msg.content.filter(
              (item: ContentItem) => item.type === "image_url"
            ).length;
            imageTokens += imageCount * TOKENS_PER_IMAGE;
          }
        }
        
        req.log.debug(
          { imageCount: imageTokens / TOKENS_PER_IMAGE, tokenEstimate: imageTokens },
          "Estimated token count for Mistral vision images"
        );
      }
      
      const prompt: string | MistralAIChatMessage[] = messages ?? req.body.prompt;
      result = await countTokens({ req, prompt, service });
      
      // Add the image tokens to the total count
      if (imageTokens > 0) {
        result.token_count += imageTokens;
      }
      
      break;
    }
    case "openai-image": {
      req.outputTokens = 1;
      result = await countTokens({ req, service });
      break;
    }
    
    // Handle XAI (Grok) vision models
    // Since it uses the OpenAI API format, it's caught in the "openai" case,
    // but we need to add additional handling for image tokens after that
    default:
      assertNever(service);
  }

  req.promptTokens = result.token_count;

  req.log.debug({ result: result }, "Counted prompt tokens.");
  req.tokenizerInfo = req.tokenizerInfo ?? {};
  req.tokenizerInfo = { ...req.tokenizerInfo, ...result };
};
