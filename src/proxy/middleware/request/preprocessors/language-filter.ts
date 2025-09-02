import { Request } from "express";
import { z } from "zod";
import { config } from "../../../../config";
import { assertNever } from "../../../../shared/utils";
import { RequestPreprocessor } from "../index";
import { BadRequestError } from "../../../../shared/errors";
import {
  MistralAIChatMessage,
  OpenAIChatMessage,
  flattenAnthropicMessages,
} from "../../../../shared/api-schemas";
import { GoogleAIV1GenerateContentSchema } from "../../../../shared/api-schemas/google-ai";

const rejectedClients = new Map<string, number>();

setInterval(() => {
  rejectedClients.forEach((count, ip) => {
    if (count > 0) {
      rejectedClients.set(ip, Math.floor(count / 2));
    } else {
      rejectedClients.delete(ip);
    }
  });
}, 30000);

/**
 * Block requests containing blacklisted phrases. Repeated rejections from the
 * same IP address will be throttled.
 */
export const languageFilter: RequestPreprocessor = async (req) => {
  if (!config.rejectPhrases.length) return;

  const prompt = getPromptFromRequest(req);
  const match = config.rejectPhrases.find((phrase) =>
    prompt.match(new RegExp(phrase, "i"))
  );

  if (match) {
    const ip = req.ip;
    const rejections = (rejectedClients.get(req.ip) || 0) + 1;
    const delay = Math.min(60000, Math.pow(2, rejections - 1) * 1000);
    rejectedClients.set(ip, rejections);
    req.log.warn(
      { match, ip, rejections, delay },
      "Prompt contains rejected phrase"
    );
    await new Promise((resolve) => {
      req.res!.once("close", resolve);
      setTimeout(resolve, delay);
    });
    throw new BadRequestError(config.rejectMessage);
  }
};

/* 
TODO: this is not type safe and does not raise errors if request body zod schema
is changed.
*/
function getPromptFromRequest(req: Request) {
  const service = req.outboundApi;
  const body = req.body;
  switch (service) {
    case "anthropic-chat":
      return flattenAnthropicMessages(body.messages);
    case "openai":
    case "mistral-ai":
      return body.messages
        .map((msg: OpenAIChatMessage | MistralAIChatMessage) => {
          const text = Array.isArray(msg.content)
            ? msg.content
                .map((c) => {
                  if ("text" in c) return c.text;
                })
                .join()
            : msg.content;
          return `${msg.role}: ${text}`;
        })
        .join("\n\n");
    case "anthropic-text":
    case "openai-text":
    case "openai-responses":
    case "openai-image":
    case "mistral-text":
      return body.prompt;
    case "google-ai": {
      const b = body as z.infer<typeof GoogleAIV1GenerateContentSchema>;
      return [
        b.systemInstruction?.parts.filter(p => 'text' in p).map((p) => (p as { text: string }).text),
        ...b.contents.flatMap((c) => c.parts.filter(p => 'text' in p).map((p) => (p as { text: string }).text)),
      ].join("\n");
    }
    default:
      assertNever(service);
  }
}
