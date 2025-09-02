import { z } from "zod";
import { OPENAI_OUTPUT_MAX } from "./openai";

/**
 * Helper function to check if a model is from Qwen
 */
export function isQwenModel(model: string): boolean {
  // Remove any suffix like -thinking or -nonthinking for checking
  const baseModel = model.replace(/-thinking$|-nonthinking$/, '');
  return baseModel.startsWith("qwen") || baseModel.includes("qwen");
}

/**
 * Helper function to check if a model supports thinking capability
 */
export function isQwenThinkingModel(model: string): boolean {
  // Remove any suffix like -thinking or -nonthinking for checking
  const baseModel = model.replace(/-thinking$|-nonthinking$/, '');
  
  // All Qwen3 models support thinking
  if (baseModel.startsWith("qwen3")) {
    return true;
  }
  
  // Other models that support thinking
  return (
    baseModel === "qwen-plus-latest" || 
    baseModel === "qwen-plus-2025-04-28" || 
    baseModel === "qwen-turbo-latest" || 
    baseModel === "qwen-turbo-2025-04-28"
  );
}

// Basic chat message schema
const QwenChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().nullable(),
  name: z.string().optional(),
});

const QwenMessagesSchema = z.array(QwenChatMessageSchema);

// Schema for Qwen chat completions
export const QwenV1ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: QwenMessagesSchema,
  temperature: z.number().optional().default(1),
  top_p: z.number().optional().default(1),
  max_tokens: z.coerce
    .number()
    .int()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  stream: z.boolean().optional().default(false),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default([])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  seed: z.number().int().min(0).optional(),
  response_format: z
    .object({ 
      type: z.enum(["text", "json_object"]),
      schema: z.any().optional()
    })
    .optional(),
  tools: z.array(z.any()).optional(),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
  // Qwen-specific parameters
  enable_thinking: z.boolean().optional(),
  thinking_budget: z.number().optional(),
});

// Schema for Qwen embeddings
export const QwenV1EmbeddingsSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).optional()
});

/**
 * Helper function to normalize messages for Qwen API
 * Qwen uses the standard OpenAI message format, so no transformation is needed
 */
export function normalizeMessages(messages: any[]): any[] {
  return messages;
}

/**
 * Helper function to check if a model is a Qwen3 model
 */
export function isQwen3Model(model: string): boolean {
  // Remove any suffix like -thinking or -nonthinking for checking
  const baseModel = model.replace(/-thinking$|-nonthinking$/, '');
  return baseModel.startsWith("qwen3");
}

/**
 * Helper function to check if a model name has the thinking variant suffix
 */
export function isThinkingVariant(model: string): boolean {
  return model.endsWith("-thinking");
}

/**
 * Helper function to check if a model name has the non-thinking variant suffix
 */
export function isNonThinkingVariant(model: string): boolean {
  return model.endsWith("-nonthinking");
}

/**
 * Get the base model name without any thinking/nonthinking suffix
 */
export function getBaseModelName(model: string): string {
  return model.replace(/-thinking$|-nonthinking$/, '');
}
