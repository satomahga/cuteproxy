import { StreamingCompletionTransformer } from "../index";
import { parseEvent, ServerSentEvent } from "../parse-sse";
import { logger } from "../../../../../logger";

const log = logger.child({
  module: "sse-transformer",
  transformer: "google-ai-to-openai",
});

type GoogleAIStreamEvent = {
  candidates: {
    content?: { parts?: { text: string }[]; role: string };
    finishReason?: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER";
    index: number;
    tokenCount?: number;
    safetyRatings: { category: string; probability: string }[];
  }[];
};

/**
 * Transforms an incoming Google AI SSE to an equivalent OpenAI
 * chat.completion.chunk SSE.
 */
export const googleAIToOpenAI: StreamingCompletionTransformer = (params) => {
  const { data, index } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || rawEvent.data === "[DONE]") {
    return { position: -1 };
  }

  const completionEvent = asCompletion(rawEvent);
  if (!completionEvent) {
    return { position: -1 };
  }

  const parts = completionEvent.candidates[0].content?.parts || [];
  let content = parts[0]?.text ?? "";

  if (isSafetyStop(completionEvent)) {
    content = `[Proxy Warning] Gemini safety filter triggered: ${JSON.stringify(
      completionEvent.candidates[0].safetyRatings
    )}`;
  }

  // If this is the first chunk, try stripping speaker names from the response
  // e.g. "John: Hello" -> "Hello"
  if (index === 0) {
    content = content.replace(/^(.*?): /, "").trim();
  }

  const newEvent = {
    id: "goo-" + params.fallbackId,
    object: "chat.completion.chunk" as const,
    created: Date.now(),
    model: params.fallbackModel,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: completionEvent.candidates[0].finishReason ?? null,
      },
    ],
  };

  return { position: -1, event: newEvent };
};

function isSafetyStop(completion: GoogleAIStreamEvent) {
  const isSafetyStop = ["SAFETY", "OTHER"].includes(
    completion.candidates[0].finishReason ?? ""
  );
  const hasNoContent = completion.candidates[0].content?.parts?.length === 0;
  return isSafetyStop && hasNoContent;
}

function asCompletion(event: ServerSentEvent): GoogleAIStreamEvent | null {
  try {
    const parsed = JSON.parse(event.data) as GoogleAIStreamEvent;
    if (parsed.candidates?.length > 0) {
      return parsed;
    } else {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error("Missing required fields");
    }
  } catch (error) {
    log.warn({ error: error.stack, event }, "Received invalid event");
  }
  return null;
}
