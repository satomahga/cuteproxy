import { z } from "zod";
import { OPENAI_OUTPUT_MAX } from "./openai";

/**
 * Helper function to check if a model is from Cohere
 */
export function isCohereModel(model: string): boolean {
  // Cohere's command model family
  return model.includes("command") || model.includes("cohere");
}

// Basic chat message schema
const CohereChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.string().nullable(),
  name: z.string().optional(),
});

const CohereMessagesSchema = z.array(CohereChatMessageSchema);

// Schema for Cohere chat completions
export const CohereV1ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: CohereMessagesSchema,
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
  // Structured output with schema
  tools: z.array(z.any()).optional(),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().optional().default(0),
});

// Schema for Cohere embeddings
export const CohereV1EmbeddingsSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).optional()
});

// Helper function to convert between different message formats if needed
export function normalizeMessages(messages: any[]): any[] {
  // From documentation, Cohere supports roles: developer, user, assistant
  // The 'developer' role is equivalent to 'system' in OpenAI API
  return messages.map((msg) => {
    // Convert system role to developer role for Cohere compatibility
    if (msg.role === "system") {
      return { ...msg, role: "developer" };
    }
    return msg;
  });
}
