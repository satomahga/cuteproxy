import { sendProxyError } from "../common";
import type { RawResponseBodyHandler } from "./index";
import { decompressBuffer } from "./compression";

/**
 * Handles the response from the upstream service and decodes the body if
 * necessary. If the response is JSON, it will be parsed and returned as an
 * object. Otherwise, it will be returned as a string. Does not handle streaming
 * responses.
 * @throws {Error} Unsupported content-encoding or invalid application/json body
 */
export const handleBlockingResponse: RawResponseBodyHandler = async (
  proxyRes,
  req,
  res
) => {
  if (req.isStreaming) {
    const err = new Error(
      "handleBlockingResponse called for a streaming request."
    );
    req.log.error({ stack: err.stack, api: req.inboundApi }, err.message);
    throw err;
  }

  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", async () => {
      const contentEncoding = proxyRes.headers["content-encoding"];
      const contentType = proxyRes.headers["content-type"];
      let body: string | Buffer = Buffer.concat(chunks);
      const rejectWithMessage = function (msg: string, err: Error) {
        const error = `${msg} (${err.message})`;
        req.log.warn(
          { msg: error, stack: err.stack },
          "Error in blocking response handler"
        );
        sendProxyError(req, res, 500, "Internal Server Error", { error });
        return reject(error);
      };

      try {
        body = await decompressBuffer(body, contentEncoding);
      } catch (e) {
        return rejectWithMessage(`Could not decode response body`, e);
      }

      try {
        return resolve(tryParseAsJson(body, contentType));
      } catch (e) {
        return rejectWithMessage("API responded with invalid JSON", e);
      }
    });
  });
};

function tryParseAsJson(body: string, contentType?: string) {
  // If the response is declared as JSON, it must parse or we will throw
  if (contentType?.includes("application/json")) {
    return JSON.parse(body);
  }
  // If it's not declared as JSON, some APIs we'll try to parse it as JSON
  // anyway since some APIs return the wrong content-type header in some cases.
  // If it fails to parse, we'll just return the raw body without throwing.
  try {
    return JSON.parse(body);
  } catch (e) {
    return body;
  }
}
