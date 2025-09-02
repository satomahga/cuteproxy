import type { ProxyReqMutator } from "../index";

/** Finalize the rewritten request body. Must be the last mutator. */
export const finalizeBody: ProxyReqMutator = (manager) => {
  const req = manager.request;

  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {
    // For image generation requests, remove stream flag.
    if (req.outboundApi === "openai-image") {
      delete req.body.stream;
    }
    // For anthropic text to chat requests, remove undefined prompt.
    if (req.outboundApi === "anthropic-chat") {
      delete req.body.prompt;
    }
    // For OpenAI Responses API, ensure messages is in the correct format
    if (req.outboundApi === "openai-responses") {
      // Format messages for the Responses API
      if (req.body.messages) {
        req.log.info("Formatting messages for Responses API in finalizeBody");
        // The Responses API expects input to be an array, not an object
        req.body.input = req.body.messages;
        delete req.body.messages;
      } else if (req.body.input && req.body.input.messages) {
        req.log.info("Reformatting input.messages for Responses API in finalizeBody");
        // If input already exists but contains a messages object, replace input with the messages array
        req.body.input = req.body.input.messages;
      }
      
      // Final check to ensure max_completion_tokens is converted to max_output_tokens
      if (req.body.max_completion_tokens) {
        req.log.info("Converting max_completion_tokens to max_output_tokens in finalizeBody");
        if (!req.body.max_output_tokens) {
          req.body.max_output_tokens = req.body.max_completion_tokens;
        }
        delete req.body.max_completion_tokens;
      }
      
      // Final check to ensure max_tokens is converted to max_output_tokens
      if (req.body.max_tokens) {
        req.log.info("Converting max_tokens to max_output_tokens in finalizeBody");
        if (!req.body.max_output_tokens) {
          req.body.max_output_tokens = req.body.max_tokens;
        }
        delete req.body.max_tokens;
      }
      
      // Remove all parameters not supported by Responses API
      const unsupportedParams = [
        'frequency_penalty',
        'presence_penalty',
      ];
      
      for (const param of unsupportedParams) {
        if (req.body[param] !== undefined) {
          req.log.info(`Removing unsupported parameter for Responses API: ${param}`);
          delete req.body[param];
        }
      }
    }

    const serialized =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    manager.setHeader("Content-Length", String(Buffer.byteLength(serialized)));
    manager.setBody(serialized);
  }
};
