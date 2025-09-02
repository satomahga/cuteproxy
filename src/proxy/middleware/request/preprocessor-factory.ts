import { RequestHandler } from "express";
import { ZodIssue } from "zod";
import { initializeSseStream } from "../../../shared/streaming";
import { classifyErrorAndSend } from "../common";
import {
  RequestPreprocessor,
  blockZoomerOrigins,
  countPromptTokens,
  languageFilter,
  setApiFormat,
  transformOutboundPayload,
  validateContextSize,
  validateModelFamily,
  validateVision,
  applyQuotaLimits,
} from ".";

type RequestPreprocessorOptions = {
  /**
   * Functions to run before the request body is transformed between API
   * formats. Use this to change the behavior of the transformation, such as for
   * endpoints which can accept multiple API formats.
   */
  beforeTransform?: RequestPreprocessor[];
  /**
   * Functions to run after the request body is transformed and token counts are
   * assigned. Use this to perform validation or other actions that depend on
   * the request body being in the final API format.
   */
  afterTransform?: RequestPreprocessor[];
};

/**
 * Returns a middleware function that processes the request body into the given
 * API format, and then sequentially runs the given additional preprocessors.
 * These should be used for validation and transformations that only need to
 * happen once per request.
 *
 * These run first in the request lifecycle, a single time per request before it
 * is added to the request queue. They aren't run again if the request is
 * re-attempted after a rate limit.
 *
 * To run functions against requests every time they are re-attempted, write a
 * ProxyReqMutator and pass it to createQueuedProxyMiddleware instead.
 */
export const createPreprocessorMiddleware = (
  apiFormat: Parameters<typeof setApiFormat>[0],
  { beforeTransform, afterTransform }: RequestPreprocessorOptions = {}
): RequestHandler => {
  const preprocessors: RequestPreprocessor[] = [
    setApiFormat(apiFormat),
    blockZoomerOrigins,
    ...(beforeTransform ?? []),
    transformOutboundPayload,
    countPromptTokens,
    languageFilter,
    ...(afterTransform ?? []),
    validateContextSize,
    validateVision,
    validateModelFamily,
    applyQuotaLimits,
  ];
  return async (...args) => executePreprocessors(preprocessors, args);
};

/**
 * Returns a middleware function that specifically prepares requests for
 * OpenAI's embeddings API. Tokens are not counted because embeddings requests
 * are basically free.
 */
export const createEmbeddingsPreprocessorMiddleware = (): RequestHandler => {
  const preprocessors: RequestPreprocessor[] = [
    setApiFormat({ inApi: "openai", outApi: "openai", service: "openai" }),
    (req) => void (req.promptTokens = req.outputTokens = 0),
  ];
  return async (...args) => executePreprocessors(preprocessors, args);
};

async function executePreprocessors(
  preprocessors: RequestPreprocessor[],
  [req, res, next]: Parameters<RequestHandler>
) {
  handleTestMessage(req, res, next);
  if (res.headersSent) return;

  try {
    for (const preprocessor of preprocessors) {
      await preprocessor(req);
    }
    next();
  } catch (error) {
    if (error.constructor.name === "ZodError") {
      const issues = error?.issues
        ?.map((issue: ZodIssue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      req.log.warn({ issues }, "Prompt failed preprocessor validation.");
    } else {
      req.log.error(error, "Error while executing request preprocessor");
    }

    // If the requested has opted into streaming, the client probably won't
    // handle a non-eventstream response, but we haven't initialized the SSE
    // stream yet as that is typically done later by the request queue. We'll
    // do that here and then call classifyErrorAndSend to use the streaming
    // error handler.
    const { stream } = req.body;
    const isStreaming = stream === "true" || stream === true;
    if (isStreaming && !res.headersSent) {
      initializeSseStream(res);
    }
    classifyErrorAndSend(error as Error, req, res);
  }
}

/**
 * Bypasses the API call and returns a test message response if the request body
 * is a known test message from SillyTavern. Otherwise these messages just waste
 * API request quota and confuse users when the proxy is busy, because ST always
 * makes them with `stream: false` (which is not allowed when the proxy is busy)
 */
const handleTestMessage: RequestHandler = (req, res) => {
  const { method, body } = req;
  if (method !== "POST") {
    return;
  }

  if (isTestMessage(body)) {
    req.log.info({ body }, "Received test message. Skipping API call.");
    res.json({
      id: "test-message",
      object: "chat.completion",
      created: Date.now(),
      model: body.model,
      // openai chat
      choices: [
        {
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
          index: 0,
        },
      ],
      // anthropic text
      completion: "Hello!",
      // anthropic chat
      content: [{ type: "text", text: "Hello!" }],
      // gemini
      candidates: [
        {
          content: { parts: [{ text: "Hello!" }] },
          finishReason: "stop",
        },
      ],
      proxy_note:
        "SillyTavern connection test detected. Your prompt was not sent to the actual model and this response was generated by the proxy.",
    });
  }
};

function isTestMessage(body: any) {
  const { messages, prompt, contents } = body;

  if (messages) {
    return (
      messages.length === 1 &&
      messages[0].role === "user" &&
      messages[0].content === "Hi"
    );
  } else if (contents) {
    return contents.length === 1 && contents[0].parts[0]?.text === "Hi";
  } else {
    return (
      prompt?.trim() === "Human: Hi\n\nAssistant:" ||
      prompt?.startsWith("Hi\n\n")
    );
  }
}
