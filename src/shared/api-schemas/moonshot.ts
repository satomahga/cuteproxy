import { z } from "zod";
import { OPENAI_OUTPUT_MAX } from "./openai";

/**
 * Helper function to check if a model is from Moonshot
 */
export function isMoonshotModel(model: string): boolean {
  return model.includes("moonshot");
}

/**
 * Helper function to check if a model is a Moonshot vision model
 */
export function isMoonshotVisionModel(model: string): boolean {
  return model.includes("moonshot") && model.includes("vision");
}

// Content schema for vision models
const MoonshotVisionContentSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({
        type: z.literal("text"),
        text: z.string(),
      }),
      z.object({
        type: z.literal("image_url"),
        image_url: z.object({
          url: z.string(),
          detail: z.enum(["low", "high", "auto"]).optional(),
        }),
      }),
    ])
  ),
]);

// Basic chat message schema
const MoonshotChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), MoonshotVisionContentSchema]).nullable(),
  name: z.string().optional(),
  // Support for partial mode
  partial: z.boolean().optional(),
});

const MoonshotMessagesSchema = z.array(MoonshotChatMessageSchema);

// Schema for Moonshot chat completions
export const MoonshotV1ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: MoonshotMessagesSchema,
  temperature: z.number().optional().default(0.3),
  top_p: z.number().optional().default(1),
  max_tokens: z.coerce
    .number()
    .int()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  stream: z.boolean().optional().default(false),
  stop: z
    .union([z.string(), z.array(z.string()).max(5)])
    .optional()
    .default([])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  seed: z.number().int().min(0).optional(),
  response_format: z
    .object({ 
      type: z.enum(["text", "json_object"])
    })
    .optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
  frequency_penalty: z.number().min(-2).max(2).optional().default(0),
  presence_penalty: z.number().min(-2).max(2).optional().default(0),
  n: z.number().int().min(1).max(5).optional().default(1),
});

// Schema for Moonshot embeddings
export const MoonshotV1EmbeddingsSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).optional()
});

// Note: Partial mode handling is implemented directly in the proxy middleware
// to follow the Deepseek-style consolidation pattern
