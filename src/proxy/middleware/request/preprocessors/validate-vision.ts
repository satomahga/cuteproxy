import { config } from "../../../../config";
import { assertNever } from "../../../../shared/utils";
import { RequestPreprocessor } from "../index";
import { containsImageContent as containsImageContentOpenAI } from "../../../../shared/api-schemas/openai";
import { containsImageContent as containsImageContentAnthropic } from "../../../../shared/api-schemas/anthropic";
import { containsImageContent as containsImageContentGoogleAI } from "../../../../shared/api-schemas/google-ai";
import { containsImageContent as containsImageContentMistralAI } from "../../../../shared/api-schemas/mistral-ai";
import { ForbiddenError } from "../../../../shared/errors";

/**
 * Rejects prompts containing images if multimodal prompts are disabled.
 */
export const validateVision: RequestPreprocessor = async (req) => {
  if (req.service === undefined) {
    throw new Error("Request service must be set before validateVision");
  }

  if (req.user?.type === "special") return;
  if (config.allowedVisionServices.includes(req.service)) return;

  // vision not allowed for req's service, block prompts with images
  let hasImage = false;
  switch (req.outboundApi) {
    case "openai":
      hasImage = containsImageContentOpenAI(req.body.messages);
      break;
    case "openai-responses":
      hasImage = containsImageContentOpenAI(req.body.messages);
      break;
    case "anthropic-chat":
      hasImage = containsImageContentAnthropic(req.body.messages);
      break;
    case "google-ai":
      hasImage = containsImageContentGoogleAI(req.body.contents);
      break;
    case "anthropic-text":
    case "mistral-ai":
      if (req.body.messages) {
        hasImage = containsImageContentMistralAI(req.body.messages);
      }
      break;
    case "mistral-text":
    case "openai-image":
    case "openai-text":
      return;
    default:
      assertNever(req.outboundApi);
  }

  if (hasImage) {
    throw new ForbiddenError(
      "Prompts containing images are not permitted. Disable 'Send Inline Images' in your client and try again."
    );
  }
};
