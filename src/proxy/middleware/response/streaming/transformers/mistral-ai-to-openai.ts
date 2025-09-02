import { logger } from "../../../../../logger";
import { MistralAIStreamEvent, SSEResponseTransformArgs } from "../index";
import { parseEvent, ServerSentEvent } from "../parse-sse";

const log = logger.child({
  module: "sse-transformer",
  transformer: "mistral-ai-to-openai",
});

export const mistralAIToOpenAI = (params: SSEResponseTransformArgs) => {
  const { data } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || rawEvent.data === "[DONE]") {
    return { position: -1 };
  }

  const completionEvent = asCompletion(rawEvent);
  if (!completionEvent) {
    return { position: -1 };
  }

  if ("choices" in completionEvent) {
    const newChatEvent = {
      id: params.fallbackId,
      object: "chat.completion.chunk" as const,
      created: Date.now(),
      model: params.fallbackModel,
      choices: [
        {
          index: completionEvent.choices[0].index,
          delta: { content: completionEvent.choices[0].message.content },
          finish_reason: completionEvent.choices[0].stop_reason,
        },
      ],
    };
    return { position: -1, event: newChatEvent };
  } else if ("outputs" in completionEvent) {
    const newTextEvent = {
      id: params.fallbackId,
      object: "chat.completion.chunk" as const,
      created: Date.now(),
      model: params.fallbackModel,
      choices: [
        {
          index: 0,
          delta: { content: completionEvent.outputs[0].text },
          finish_reason: completionEvent.outputs[0].stop_reason,
        },
      ],
    };
    return { position: -1, event: newTextEvent };
  }

  // should never happen
  return { position: -1 };
};

function asCompletion(event: ServerSentEvent): MistralAIStreamEvent | null {
  try {
    const parsed = JSON.parse(event.data);
    if (
      (Array.isArray(parsed.choices) &&
        parsed.choices[0].message !== undefined) ||
      (Array.isArray(parsed.outputs) && parsed.outputs[0].text !== undefined)
    ) {
      return parsed;
    } else {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error("Missing required fields");
    }
  } catch (error) {
    log.warn({ error: error.stack, event }, "Received invalid data event");
  }
  return null;
}
