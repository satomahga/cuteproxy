import { z } from "zod";
import { OPENAI_OUTPUT_MAX } from "./openai";
import { Template } from "@huggingface/jinja";
import { APIFormatTransformer } from "./index";
import { logger } from "../../logger";

// Define the content types for multimodal messages
export const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});

export const ImageUrlContentSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.union([
    // URL format (https://...)
    z.string().url(),
    // Base64 format (data:image/jpeg;base64,...)
    z.string().regex(/^data:image\/(jpeg|png|gif|webp);base64,/),
    // Object format (might contain detail or url properties)
    z.record(z.any()),
    // Allow any string for maximum compatibility
    z.string()
  ])
});

export const ContentItemSchema = z.union([TextContentSchema, ImageUrlContentSchema]);

// Export types for the content schemas
export type TextContent = z.infer<typeof TextContentSchema>;
export type ImageUrlContent = z.infer<typeof ImageUrlContentSchema>;
export type ContentItem = z.infer<typeof ContentItemSchema>;

// List of Mistral models with vision capabilities
export const MISTRAL_VISION_MODELS = [
  "pixtral-12b-2409",
  "pixtral-12b-latest",
  "pixtral-large-2411",
  "pixtral-large-latest",
  "mistral-small-2503",
  "mistral-small-latest",
  "mistral-medium-latest",
  "mistral-medium-2505"
];

// Helper function to check if a model supports vision
export function isMistralVisionModel(model: string): boolean {
  return MISTRAL_VISION_MODELS.some(visionModel => 
    model === visionModel || 
    model.startsWith(`${visionModel}-`)
  );
}

// Main Mistral chat message schema
const MistralChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]), // TODO: implement tools
  // Support both string content (for backwards compatibility) and array of content items (for multimodal)
  content: z.union([
    z.string(),
    z.array(ContentItemSchema)
  ]),
  prefix: z.boolean().optional(),
});

const MistralMessagesSchema = z.array(MistralChatMessageSchema).refine(
  (input) => {
    const prefixIdx = input.findIndex((msg) => Boolean(msg.prefix));
    if (prefixIdx === -1) return true; // no prefix messages
    const lastIdx = input.length - 1;
    const lastMsg = input[lastIdx];
    return prefixIdx === lastIdx && lastMsg.role === "assistant";
  },
  {
    message:
      "`prefix` can only be set to `true` on the last message, and only for an assistant message.",
  }
);

// https://docs.mistral.ai/api#operation/createChatCompletion
const BaseMistralAIV1CompletionsSchema = z.object({
  model: z.string(),
  messages: MistralMessagesSchema.optional(),
  prompt: z.string().optional(),
  temperature: z.number().optional().default(0.7),
  top_p: z.number().optional().default(1),
  max_tokens: z.coerce
    .number()
    .int()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  stream: z.boolean().optional().default(false),
  // Mistral docs say that `stop` can be a string or array but AWS Mistral
  // blows up if a string is passed. We must convert it to an array.
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default([])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  random_seed: z.number().int().min(0).optional(),
  response_format: z
    .object({ type: z.enum(["text", "json_object"]) })
    .optional(),
  safe_prompt: z.boolean().optional().default(false),
});

export const MistralAIV1ChatCompletionsSchema =
  BaseMistralAIV1CompletionsSchema.and(
    z.object({ messages: MistralMessagesSchema })
  );
export const MistralAIV1TextCompletionsSchema =
  BaseMistralAIV1CompletionsSchema.and(z.object({ prompt: z.string() }));

/*
  Slightly more strict version that only allows a subset of the parameters. AWS
  Mistral helpfully returns no details if unsupported parameters are passed so
  this list comes from trial and error as of 2024-08-12.
*/
const BaseAWSMistralAIV1CompletionsSchema =
  BaseMistralAIV1CompletionsSchema.pick({
    temperature: true,
    top_p: true,
    max_tokens: true,
    stop: true,
    random_seed: true,
    // response_format: true,
    // safe_prompt: true,
  }).strip();
export const AWSMistralV1ChatCompletionsSchema =
  BaseAWSMistralAIV1CompletionsSchema.and(
    z.object({ messages: MistralMessagesSchema })
  );
export const AWSMistralV1TextCompletionsSchema =
  BaseAWSMistralAIV1CompletionsSchema.and(z.object({ prompt: z.string() }));

export type MistralAIChatMessage = z.infer<typeof MistralChatMessageSchema>;

export function fixMistralPrompt(
  messages: MistralAIChatMessage[]
): MistralAIChatMessage[] {
  // Mistral uses OpenAI format but has some additional requirements:
  // - Only one system message per request, and it must be the first message if
  //   present.
  // - Final message must be a user message, unless it has `prefix: true`.
  // - Cannot have multiple messages from the same role in a row.
  // While frontends should be able to handle this, we can fix it here in the
  // meantime.
  const fixed = messages.reduce<MistralAIChatMessage[]>((acc, msg) => {
    if (acc.length === 0) {
      acc.push(msg);
      return acc;
    }

    const copy = { ...msg };
    // Reattribute subsequent system messages to the user
    if (msg.role === "system") {
      copy.role = "user";
    }

    // Consolidate multiple messages from the same role
    const last = acc[acc.length - 1];
    if (last.role === copy.role) {
      // Handle different content types for consolidation
      if (typeof last.content === "string" && typeof copy.content === "string") {
        // Both are strings, concatenate them
        last.content += "\n\n" + copy.content;
      } else if (Array.isArray(last.content) && typeof copy.content === "string") {
        // Add the string content as a new text content item
        last.content.push({
          type: "text",
          text: copy.content
        });
      } else if (typeof last.content === "string" && Array.isArray(copy.content)) {
        // Convert last.content to array and append copy.content items
        last.content = [
          { type: "text", text: last.content },
          ...copy.content
        ];
      } else if (Array.isArray(last.content) && Array.isArray(copy.content)) {
        // Both are arrays, concatenate them
        last.content = [...last.content, ...copy.content];
      }
    } else {
      acc.push(copy);
    }
    return acc;
  }, []);

  // If the last message is an assistant message, mark it as a prefix. An
  // assistant message at the end of the conversation without `prefix: true`
  // results in an error.
  if (fixed[fixed.length - 1].role === "assistant") {
    fixed[fixed.length - 1].prefix = true;
  }
  return fixed;
}

let jinjaTemplate: Template;
let renderTemplate: (messages: MistralAIChatMessage[]) => string;

// Helper function to convert multimodal content to string format for text-only models
function contentToString(content: string | any[]): string {
  if (typeof content === "string") {
    return content;
  } else if (Array.isArray(content)) {
    // For multimodal content, extract only the text parts
    // Images are not supported in text-only templates
    return content
      .filter(item => item.type === "text")
      .map(item => (item as any).text)
      .join("\n\n");
  }
  return "";
}

function renderMistralPrompt(messages: MistralAIChatMessage[]) {
  if (!jinjaTemplate) {
    logger.warn("Lazy loading mistral chat template...");
    const { chatTemplate, bosToken, eosToken } =
      require("./templates/mistral-template").MISTRAL_TEMPLATE;
    jinjaTemplate = new Template(chatTemplate);
    renderTemplate = (messages) => {
      // We need to convert any multimodal content to string format for the template
      const textOnlyMessages = messages.map(msg => ({
        ...msg,
        content: contentToString(msg.content)
      }));
      
      return jinjaTemplate.render({
        messages: textOnlyMessages,
        bos_token: bosToken,
        eos_token: eosToken,
      });
    };
  }

  return renderTemplate(messages);
}

/**
 * Attempts to convert a Mistral chat completions request to a text completions,
 * using the official prompt template published by Mistral.
 * 
 * Note: This transformation is only applicable for text-only models.
 * Multimodal/vision models (Pixtral, etc.) cannot use this transformation.
 */
export const transformMistralChatToText: APIFormatTransformer<
  typeof MistralAIV1TextCompletionsSchema
> = async (req) => {
  const { body } = req;
  const result = MistralAIV1ChatCompletionsSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid Mistral chat completions request"
    );
    throw result.error;
  }

  // Check if this is a vision request (contains any image_url content items)
  const { messages, model, ...rest } = result.data;
  const hasVisionContent = messages.some(msg => 
    Array.isArray(msg.content) && 
    msg.content.some(item => item.type === "image_url")
  );

  // Cannot transform vision requests to text completions
  if (hasVisionContent) {
    req.log.warn(
      { model },
      "Cannot transform Mistral vision request to text completions format"
    );
    throw new Error(
      "Vision requests (with image_url content) cannot be transformed to text completions format"
    );
  }

  const prompt = renderMistralPrompt(messages);
  return { ...rest, model, prompt, messages: undefined };
};

export function containsImageContent(messages: MistralAIChatMessage[]): boolean {
  if (!messages || !Array.isArray(messages)) {
    return false;
  }

  return messages.some(msg => {
    if (typeof msg.content === "string") {
      return false;
    }

    if (Array.isArray(msg.content)) {
      return msg.content.some(item => item.type === "image_url");
    }

    return false;
  });
}