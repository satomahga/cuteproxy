import { OpenAIChatCompletionStreamEvent } from "../index";

export type MistralChatCompletionResponse = {
  choices: {
    index: number;
    message: { role: string; content: string };
    finish_reason: string | null;
  }[];
};

/**
 * Given a list of OpenAI chat completion events, compiles them into a single
 * finalized Mistral chat completion response so that non-streaming middleware
 * can operate on it as if it were a blocking response.
 */
export function mergeEventsForMistralChat(
  events: OpenAIChatCompletionStreamEvent[]
): MistralChatCompletionResponse {
  let merged: MistralChatCompletionResponse = {
    choices: [
      { index: 0, message: { role: "", content: "" }, finish_reason: "" },
    ],
  };
  merged = events.reduce((acc, event, i) => {
    // The first event will only contain role assignment and response metadata
    if (i === 0) {
      acc.choices[0].message.role = event.choices[0].delta.role ?? "assistant";
      return acc;
    }

    acc.choices[0].finish_reason = event.choices[0].finish_reason ?? "";
    if (event.choices[0].delta.content) {
      acc.choices[0].message.content += event.choices[0].delta.content;
    }

    return acc;
  }, merged);
  return merged;
}
