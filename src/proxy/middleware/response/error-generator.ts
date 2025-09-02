import express from "express";
import { APIFormat } from "../../../shared/key-management";
import { assertNever } from "../../../shared/utils";
import { initializeSseStream } from "../../../shared/streaming";
import http from "http";

/**
 * Returns a Markdown-formatted message that renders semi-nicely in most chat
 * frontends. For example:
 *
 * **Proxy error (HTTP 404 Not Found)**
 * The proxy encountered an error while trying to send your prompt to the upstream service. Further technical details are provided below.
 * ***
 * *The requested Claude model might not exist, or the key might not be provisioned for it.*
 * ```
 * {
 *  "type": "error",
 *  "error": {
 *    "type": "not_found_error",
 *    "message": "model: some-invalid-model-id",
 *   },
 *  "proxy_note": "The requested Claude model might not exist, or the key might not be provisioned for it."
 * }
 * ```
 */
function getMessageContent(params: {
  title: string;
  message: string;
  obj?: Record<string, any>;
}) {
  const { title, message, obj } = params;
  const note = obj?.proxy_note || obj?.error?.message || "";
  const header = `### **${title}**`;
  const friendlyMessage = note ? `${message}\n\n----\n\n*${note}*` : message;

  const serializedObj = obj
    ? ["```", JSON.stringify(obj, null, 2), "```"].join("\n")
    : "";

  const { stack } = JSON.parse(JSON.stringify(obj ?? {}));
  let prettyTrace = "";
  if (stack && obj) {
    prettyTrace = [
      "Include this trace when reporting an issue.",
      "```",
      stack,
      "```",
    ].join("\n");
    delete obj.stack;
  }

  return [
    header,
    friendlyMessage,
    serializedObj,
    prettyTrace,
    "<!-- oai-proxy-error -->",
  ].join("\n\n");
}

type ErrorGeneratorOptions = {
  format: APIFormat | "unknown";
  title: string;
  message: string;
  obj?: Record<string, any>;
  reqId: string | number | object;
  model?: string;
  statusCode?: number;
};

/**
 * Very crude inference of the request format based on the request body. Don't
 * rely on this to be very accurate.
 */
function tryInferFormat(body: any): APIFormat | "unknown" {
  if (typeof body !== "object" || !body.model) {
    return "unknown";
  }

  if (body.model.includes("gpt")) {
    return "openai";
  }

  if (body.model.includes("mistral")) {
    return "mistral-ai";
  }

  if (body.model.includes("claude")) {
    return body.messages?.length ? "anthropic-chat" : "anthropic-text";
  }

  if (body.model.includes("gemini")) {
    return "google-ai";
  }

  return "unknown";
}

/**
 * Redacts the hostname from the error message if it contains a DNS resolution
 * error. This is to avoid leaking upstream hostnames on DNS resolution errors,
 * as those may contain sensitive information about the proxy's configuration.
 */
function redactHostname(options: ErrorGeneratorOptions): ErrorGeneratorOptions {
  if (!options.message.includes("getaddrinfo")) return options;

  const redacted = { ...options };
  redacted.message = "Could not resolve hostname";

  if (typeof redacted.obj?.error === "object") {
    redacted.obj = {
      ...redacted.obj,
      error: { message: "Could not resolve hostname" },
    };
  }

  return redacted;
}

/**
 * Generates an appropriately-formatted error response and sends it to the
 * client over their requested transport (blocking or SSE stream).
 */
export function sendErrorToClient(params: {
  options: ErrorGeneratorOptions;
  req: express.Request;
  res: express.Response;
}) {
  const { req, res } = params;
  const options = redactHostname(params.options);
  const { statusCode, message, title, obj: details } = options;

  // Since we want to send the error in a format the client understands, we
  // need to know the request format. `setApiFormat` might not have been called
  // yet, so we'll try to infer it from the request body.
  const format =
    options.format === "unknown" ? tryInferFormat(req.body) : options.format;
  if (format === "unknown") {
    // Early middleware error (auth, rate limit) so we can only send something
    // generic.
    const code = statusCode || 400;
    const hasDetails = details && Object.keys(details).length > 0;
    return res.status(code).json({
      error: {
        message,
        type: http.STATUS_CODES[code]!.replace(/\s+/g, "_").toLowerCase(),
      },
      ...(hasDetails ? { details } : {}),
    });
  }

  // Cannot modify headers if client opted into streaming and made it into the
  // proxy request queue, because that immediately starts an SSE stream.
  if (!res.headersSent) {
    res.setHeader("x-oai-proxy-error", title);
    res.setHeader("x-oai-proxy-error-status", statusCode || 500);
  }

  // By this point, we know the request format. To get the error to display in
  // chat clients' UIs, we'll send it as a 200 response as a spoofed completion
  // from the language model. Depending on whether the client is streaming, we
  // will either send an SSE event or a JSON response.
  const isStreaming = req.isStreaming || String(req.body.stream) === "true";
  if (isStreaming) {
    // User can have opted into streaming but not made it into the queue yet,
    // in which case the stream must be started first.
    if (!res.headersSent) {
      initializeSseStream(res);
    }
    res.write(buildSpoofedSSE({ ...options, format }));
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    res.status(200).json(buildSpoofedCompletion({ ...options, format }));
  }
}

/**
 * Returns a non-streaming completion object that looks like it came from the
 * service that the request is being proxied to. Used to send error messages to
 * the client and have them look like normal responses, for clients with poor
 * error handling.
 */
export function buildSpoofedCompletion({
  format,
  title,
  message,
  obj,
  reqId,
  model = "unknown",
}: ErrorGeneratorOptions & { format: Exclude<APIFormat, "unknown"> }) {
  const id = String(reqId);
  const content = getMessageContent({ title, message, obj });

  switch (format) {
    case "openai":
    case "openai-responses":
      return {
        id: "error-" + id,
        object: "chat.completion",
        created: Date.now(),
        model,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        choices: [
          {
            message: { role: "assistant", content },
            finish_reason: title,
            index: 0,
          },
        ],
      };
    case "mistral-ai":
      return {
        id: "error-" + id,
        object: "chat.completion",
        created: Date.now(),
        model,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        choices: [
          {
            message: { role: "assistant", content },
            finish_reason: title,
            index: 0,
          },
        ],
      };
    case "mistral-text":
      return {
        outputs: [{ text: content, stop_reason: title }],
        model,
      };
    case "openai-text":
      return {
        id: "error-" + id,
        object: "text_completion",
        created: Date.now(),
        model,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        choices: [
          { text: content, index: 0, logprobs: null, finish_reason: title },
        ],
      };
    case "anthropic-text":
      return {
        id: "error-" + id,
        type: "completion",
        completion: content,
        stop_reason: title,
        stop: null,
        model,
      };
    case "anthropic-chat":
      return {
        id: "error-" + id,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: content }],
        model,
        stop_reason: title,
        stop_sequence: null,
      };
    case "google-ai":
      return {
        candidates: [
          {
            content: { parts: [{ text: content }], role: "model" },
            finishReason: title,
            index: 0,
            tokenCount: null,
            safetyRatings: [],
          },
        ],
      };
    case "openai-image":
      return obj;
    default:
      assertNever(format);
  }
}

/**
 * Returns an SSE message that looks like a completion event for the service
 * that the request is being proxied to. Used to send error messages to the
 * client in the middle of a streaming request.
 */
export function buildSpoofedSSE({
  format,
  title,
  message,
  obj,
  reqId,
  model = "unknown",
}: ErrorGeneratorOptions & { format: Exclude<APIFormat, "unknown"> }) {
  const id = String(reqId);
  const content = getMessageContent({ title, message, obj });

  let event;

  switch (format) {
    case "openai":
    case "openai-responses":
      event = {
        id: "chatcmpl-" + id,
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices: [{ delta: { content }, index: 0, finish_reason: title }],
      };
      break;
    case "mistral-ai":
      event = {
        id: "chatcmpl-" + id,
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices: [{ delta: { content }, index: 0, finish_reason: title }],
      };
      break;
    case "mistral-text":
      event = {
        outputs: [{ text: content, stop_reason: title }],
      };
      break;
    case "openai-text":
      event = {
        id: "cmpl-" + id,
        object: "text_completion",
        created: Date.now(),
        choices: [
          { text: content, index: 0, logprobs: null, finish_reason: title },
        ],
        model,
      };
      break;
    case "anthropic-text":
      event = {
        completion: content,
        stop_reason: title,
        truncated: false,
        stop: null,
        model,
        log_id: "proxy-req-" + id,
      };
      break;
    case "anthropic-chat":
      event = {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: content },
      };
      break;
    case "google-ai":
      // TODO: google ai supports two streaming transports, SSE and JSON.
      // we currently only support SSE.
      // return JSON.stringify({
      event = {
        candidates: [
          {
            content: { parts: [{ text: content }], role: "model" },
            finishReason: title,
            index: 0,
            tokenCount: null,
            safetyRatings: [],
          },
        ],
      };
      break;
    case "openai-image":
      return JSON.stringify(obj);
    default:
      assertNever(format);
  }

  if (format === "anthropic-text") {
    return (
      ["event: completion", `data: ${JSON.stringify(event)}`].join("\n") +
      "\n\n"
    );
  }

  // ugh.
  if (format === "anthropic-chat") {
    return (
      [
        [
          "event: message_start",
          `data: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "error-" + id,
              type: "message",
              role: "assistant",
              content: [],
              model,
            },
          })}`,
        ].join("\n"),
        [
          "event: content_block_start",
          `data: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}`,
        ].join("\n"),
        ["event: content_block_delta", `data: ${JSON.stringify(event)}`].join(
          "\n"
        ),
        [
          "event: content_block_stop",
          `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
        ].join("\n"),
        [
          "event: message_delta",
          `data: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: title, stop_sequence: null, usage: null },
          })}`,
        ],
        [
          "event: message_stop",
          `data: ${JSON.stringify({ type: "message_stop" })}`,
        ].join("\n"),
      ].join("\n\n") + "\n\n"
    );
  }

  return `data: ${JSON.stringify(event)}\n\n`;
}
