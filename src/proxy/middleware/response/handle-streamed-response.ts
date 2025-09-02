import express from "express";
import { pipeline, Readable, Transform } from "stream";
import { StringDecoder } from "string_decoder";
import { promisify } from "util";
import type { logger } from "../../../logger";
import { BadRequestError, RetryableError } from "../../../shared/errors";
import { APIFormat, keyPool } from "../../../shared/key-management";
import {
  copySseResponseHeaders,
  initializeSseStream,
} from "../../../shared/streaming";
import { reenqueueRequest } from "../../queue";
import type { RawResponseBodyHandler } from ".";
import { handleBlockingResponse } from "./handle-blocking-response";
import { buildSpoofedSSE, sendErrorToClient } from "./error-generator";
import { getAwsEventStreamDecoder } from "./streaming/aws-event-stream-decoder";
import { EventAggregator } from "./streaming/event-aggregator";
import { SSEMessageTransformer } from "./streaming/sse-message-transformer";
import { SSEStreamAdapter } from "./streaming/sse-stream-adapter";
import { getStreamDecompressor } from "./compression";

const pipelineAsync = promisify(pipeline);

/**
 * `handleStreamedResponse` consumes a streamed response from the upstream API,
 * decodes chunk-by-chunk into a stream of events, transforms those events into
 * the client's requested format, and forwards the result to the client.
 *
 * After the entire stream has been consumed, it resolves with the full response
 * body so that subsequent middleware in the chain can process it as if it were
 * a non-streaming response (to count output tokens, track usage, etc).
 *
 * In the event of an error, the request's streaming flag is unset and the
 * request is bounced back to the non-streaming response handler. If the error
 * is retryable, that handler will re-enqueue the request and also reset the
 * streaming flag. Unfortunately the streaming flag is set and unset in multiple
 * places, so it's hard to keep track of.
 */
export const handleStreamedResponse: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {
  const { headers, statusCode } = proxyRes;
  if (!req.isStreaming) {
    throw new Error("handleStreamedResponse called for non-streaming request.");
  }

  if (statusCode! > 201) {
    req.isStreaming = false;
    req.log.warn(
      { statusCode },
      `Streaming request returned error status code. Falling back to non-streaming response handler.`
    );
    return handleBlockingResponse(proxyRes, req, res);
  }

  req.log.debug({ headers }, `Starting to proxy SSE stream.`);

  // Typically, streaming will have already been initialized by the request
  // queue to send heartbeat pings.
  if (!res.headersSent) {
    copySseResponseHeaders(proxyRes, res);
    initializeSseStream(res);
  }

  const prefersNativeEvents = req.inboundApi === req.outboundApi;
  const streamOptions = {
    contentType: headers["content-type"],
    api: req.outboundApi,
    logger: req.log,
  };

  // While the request is streaming, aggregator collects all events so that we
  // can compile them into a single response object and publish that to the
  // remaining middleware. Because we have an OpenAI transformer for every
  // supported format, EventAggregator always consumes OpenAI events so that we
  // only have to write one aggregator (OpenAI input) for each output format.
  const aggregator = new EventAggregator(req);

  const decompressor = getStreamDecompressor(headers["content-encoding"]);
  // Decoder reads from the response bytes to produce a stream of plaintext.
  const decoder = getDecoder({ ...streamOptions, input: proxyRes });
  // Adapter consumes the decoded text and produces server-sent events so we
  // have a standard event format for the client and to translate between API
  // message formats.
  const adapter = new SSEStreamAdapter(streamOptions);
  // Transformer converts server-sent events from one vendor's API message
  // format to another.
  const transformer = new SSEMessageTransformer({
    inputFormat: req.outboundApi, // The format of the upstream service's events
    outputFormat: req.inboundApi, // The format the client requested
    inputApiVersion: String(req.headers["anthropic-version"]),
    logger: req.log,
    requestId: String(req.id),
    requestedModel: req.body.model,
  })
    .on("originalMessage", (msg: string) => {
      if (prefersNativeEvents) res.write(msg);
    })
    .on("data", (msg) => {
      if (!prefersNativeEvents) res.write(`data: ${JSON.stringify(msg)}\n\n`);
      aggregator.addEvent(msg);
    });

  try {
    await Promise.race([
      handleAbortedStream(req, res),
      pipelineAsync(proxyRes, decompressor, decoder, adapter, transformer),
    ]);
    req.log.debug(`Finished proxying SSE stream.`);
    res.end();
    return aggregator.getFinalResponse();
  } catch (err) {
    if (err instanceof RetryableError) {
      keyPool.markRateLimited(req.key!);
      await reenqueueRequest(req);
    } else if (err instanceof BadRequestError) {
      sendErrorToClient({
        req,
        res,
        options: {
          format: req.inboundApi,
          title: "Proxy streaming error (Bad Request)",
          message: `The API returned an error while streaming your request. Your prompt might not be formatted correctly.\n\n*${err.message}*`,
          reqId: req.id,
          model: req.body?.model,
        },
      });
    } else {
      const { message, stack, lastEvent } = err;
      const eventText = JSON.stringify(lastEvent, null, 2) ?? "undefined";
      const errorEvent = buildSpoofedSSE({
        format: req.inboundApi,
        title: "Proxy stream error",
        message: "An unexpected error occurred while streaming the response.",
        obj: { message, stack, lastEvent: eventText },
        reqId: req.id,
        model: req.body?.model,
      });
      res.write(errorEvent);
      res.write(`data: [DONE]\n\n`);
      res.end();
    }

    // At this point the response is closed. If the request resulted in any
    // tokens being consumed (suggesting a mid-stream error), we will resolve
    // and continue the middleware chain so tokens can be counted.
    if (aggregator.hasEvents()) {
      return aggregator.getFinalResponse();
    } else {
      // If there is nothing, then this was a completely failed prompt that
      // will not have billed any tokens. Throw to stop the middleware chain.
      throw err;
    }
  }
};

function handleAbortedStream(req: express.Request, res: express.Response) {
  return new Promise<void>((resolve) =>
    res.on("close", () => {
      if (!res.writableEnded) {
        req.log.info("Client prematurely closed connection during stream.");
      }
      resolve();
    })
  );
}

function getDecoder(options: {
  input: Readable;
  api: APIFormat;
  logger: typeof logger;
  contentType?: string;
}) {
  const { contentType, input, logger } = options;
  if (contentType?.includes("application/vnd.amazon.eventstream")) {
    return getAwsEventStreamDecoder({ input, logger });
  } else if (contentType?.includes("application/json")) {
    throw new Error("JSON streaming not supported, request SSE instead");
  } else {
    // Ensures split chunks across multi-byte characters are handled correctly.
    const stringDecoder = new StringDecoder("utf8");
    return new Transform({
      readableObjectMode: true,
      writableObjectMode: false,
      transform(chunk, _encoding, callback) {
        const text = stringDecoder.write(chunk);
        if (text) this.push(text);
        callback();
      },
    });
  }
}
