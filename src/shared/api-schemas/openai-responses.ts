import { z } from "zod";
import { Request } from "express";
import { OpenAIChatMessage, OpenAIV1ChatCompletionSchema } from "./openai";

// Schema for the OpenAI Responses API based on the chat completion schema
// with some additional fields specific to the Responses API
export const OpenAIV1ResponsesSchema = z.object({
  model: z.string(),
  input: z.object({
    messages: z.array(z.any())
  }).optional(),
  previousResponseId: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  user: z.string().optional(),
  tools: z.array(z.any()).optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

// Allow transforming from OpenAI Chat to Responses format
export async function transformOpenAIToOpenAIResponses(
  req: Request
): Promise<z.infer<typeof OpenAIV1ResponsesSchema>> {
  const body = { ...req.body };

  // Move 'messages' to 'input.messages' as required by the Responses API
  if (body.messages && !body.input) {
    body.input = {
      messages: body.messages
    };
    delete body.messages;
  }

  // Convert max_tokens to max_output_tokens if present and not set
  if (body.max_tokens && !body.max_output_tokens) {
    body.max_output_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  // Map conversation_id to previousResponseId if present
  if (body.conversation_id && !body.previousResponseId) {
    body.previousResponseId = body.conversation_id;
    delete body.conversation_id;
  }

  // Ensure tools have the right format if present
  if (body.tools) {
    body.tools = body.tools.map((tool: any) => ({
      ...tool,
      type: tool.type || "function"
    }));
  }

  return body;
} 