import { z } from "zod";
import { OPENAI_OUTPUT_MAX } from "./openai";

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
    z.object({
      url: z.string(),
      detail: z.enum(["low", "high"]).optional()
    }),
    // Allow any string for maximum compatibility
    z.string()
  ])
});

export const ContentItemSchema = z.union([TextContentSchema, ImageUrlContentSchema]);

// Export types for the content schemas
export type TextContent = z.infer<typeof TextContentSchema>;
export type ImageUrlContent = z.infer<typeof ImageUrlContentSchema>;
export type ContentItem = z.infer<typeof ContentItemSchema>;

// Helper function to check if a model supports vision
export function isGrokVisionModel(model: string): boolean {
  // Check if the model name contains '-vision' anywhere in the name
  // This makes it future-proof for new vision models
  return model.toLowerCase().includes("-vision");
}

// Helper function to check if a model supports image generation
export function isGrokImageGenModel(model: string): boolean {
  // Check if the model name contains '-image' anywhere in the name
  // This makes it future-proof for new image generation models
  return model.toLowerCase().includes("-image");
}

// Helper function to check if a model supports reasoning
export function isGrokReasoningModel(model: string): boolean {
  const modelLower = model.toLowerCase();
  return (modelLower.includes("-mini") && modelLower.includes("grok-3")) || 
         modelLower.includes("grok-4");
}

// Helper function to check if a model supports reasoning_effort parameter
export function isGrokReasoningEffortModel(model: string): boolean {
  // Only grok-3-mini variants support reasoning_effort parameter
  // grok-4-0709 does NOT support reasoning_effort
  const modelLower = model.toLowerCase();
  return modelLower.includes("-mini") && modelLower.includes("grok-3");
}

// Helper function to check if a model returns reasoning_content
export function isGrokReasoningContentModel(model: string): boolean {
  // Only grok-3-mini variants return reasoning_content
  // grok-4-0709 does NOT return reasoning_content
  const modelLower = model.toLowerCase();
  return modelLower.includes("-mini") && modelLower.includes("grok-3");
}

// Main Grok chat message schema
const XaiChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "function"]),
  // Support both string content (for backwards compatibility) and array of content items (for multimodal)
  content: z.union([
    z.string().nullable(),
    z.array(ContentItemSchema)
  ]),
  // Reasoning content field (for grok-3-mini models)
  reasoning_content: z.string().optional(),
  // Tool call fields
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
});

const XaiMessagesSchema = z.array(XaiChatMessageSchema);

// Basic chat completions schema
export const XaiV1ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: XaiMessagesSchema,
  temperature: z.number().optional().default(1),
  top_p: z.number().optional().default(1),
  max_completion_tokens: z.coerce
    .number()
    .int()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  max_tokens: z.coerce // Deprecated parameter, but kept for backward compatibility
    .number()
    .int()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  stream: z.boolean().optional().default(false),
  // Grok docs say that `stop` can be a string or array
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default([])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  seed: z.number().int().min(0).optional(),
  response_format: z
    .object({ type: z.enum(["text", "json_object", "json_schema"]), json_schema: z.any().optional() })
    .optional(),
  // reasoning_effort parameter for grok-3-mini models
  reasoning_effort: z.enum(["low", "medium", "high"]).optional().default("low"),
  stream_options: z.object({
    include_usage: z.boolean()
  }).optional(),
  user: z.string().optional(),
  // Fields to support function calling
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([
    z.string(),
    z.object({
      type: z.literal("function"),
      function: z.object({
        name: z.string()
      })
    })
  ]).optional(),
  // Advanced parameters
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
  logprobs: z.boolean().optional().default(false),
  top_logprobs: z.number().int().min(0).max(8).optional(),
});

// Image Generation schema
export const XaiV1ImageGenerationsSchema = z.object({
  model: z.string().optional(),
  prompt: z.string(),
  n: z.number().int().min(1).max(10).optional().default(1),
  response_format: z.enum(["url", "b64_json"]).optional().default("url"),
  user: z.string().optional(),
  // These are marked as not supported in the documentation but included for compatibility
  quality: z.string().optional(),
  size: z.string().optional(),
  style: z.string().optional(),
});

// Helper function to convert multimodal content to string format for text-only models
export function contentToString(content: string | any[] | null): string {
  if (typeof content === "string") {
    return content || "";
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
