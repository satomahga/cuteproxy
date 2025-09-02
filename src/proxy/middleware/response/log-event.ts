import { createHash } from "crypto";
import ipaddr from "ipaddr.js";
import { config } from "../../../config";
import { eventLogger } from "../../../shared/prompt-logging";
import { getModelFromBody, isTextGenerationRequest } from "../common";
import { ProxyResHandlerWithBody } from ".";
import {
  OpenAIChatMessage,
  AnthropicChatMessage,
} from "../../../shared/api-schemas";

export const logEvent: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  responseBody
) => {
  if (!config.eventLogging) return;
  if (typeof responseBody !== "object") throw new Error("Expected body to be an object");
  if (!req.user) return;

  const loggable = isTextGenerationRequest(req);
  if (!loggable) return;

  const rawMessages = Array.isArray(req.body?.messages)
    ? (req.body.messages as OpenAIChatMessage[] | AnthropicChatMessage[])
    : req.outboundApi === "openai-responses" && Array.isArray(req.body?.input)
    ? (req.body.input as OpenAIChatMessage[] | AnthropicChatMessage[])
    : undefined;

  if (!rawMessages || rawMessages.length === 0) return;

  const hashes: string[] = [];
  hashes.push(hashMessages(rawMessages));
  for (let i = 1; i <= Math.min(config.eventLoggingTrim!, rawMessages.length); i++) {
    hashes.push(hashMessages(rawMessages.slice(0, -i)));
  }

  const model = getModelFromBody(req, responseBody);
  const userToken = req.user!.token;
  const family = req.modelFamily!;
  eventLogger.logEvent({
    ip: normalizeIp(req.ip),
    type: "chat_completion",
    model,
    family,
    hashes,
    userToken,
    inputTokens: req.promptTokens ?? 0,
    outputTokens: req.outputTokens ?? 0,
  });
};

function normalizeIp(ip: string): string {
  try {
    const addr = ipaddr.parse(ip);
    if (addr.kind() === "ipv6" && (addr as any).isIPv4MappedAddress?.()) {
      return (addr as any).toIPv4Address().toString();
    }
    return addr.toString();
  } catch {
    return ip;
  }
}

const hashMessages = (
  messages: OpenAIChatMessage[] | AnthropicChatMessage[]
): string => {
  const hasher = createHash("sha256");
  const messageTexts: string[] = [];
  for (const msg of messages) {
    if (!["system", "user", "assistant"].includes((msg as any).role)) continue;
    const content: any = (msg as any).content;
    if (typeof content === "string") {
      messageTexts.push(content);
    } else if (Array.isArray(content)) {
      const first = content[0];
      if (first && first.type === "text" && typeof first.text === "string") {
        messageTexts.push(first.text);
      }
    }
  }
  hasher.update(messageTexts.join("<|im_sep|>"));
  return hasher.digest("hex");
};
