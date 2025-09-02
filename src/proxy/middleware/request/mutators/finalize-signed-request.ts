import { ProxyReqMutator } from "../index";

/**
 * For AWS/GCP/Azure/Google requests, the body is signed earlier in the request
 * pipeline, before the proxy middleware. This function just assigns the path
 * and headers to the proxy request.
 */
export const finalizeSignedRequest: ProxyReqMutator = (manager) => {
  const req = manager.request;
  if (!req.signedRequest) {
    throw new Error("Expected req.signedRequest to be set");
  }

  // The path depends on the selected model and the assigned key's region.
  manager.setPath(req.signedRequest.path);

  // Amazon doesn't want extra headers, so we need to remove all of them and
  // reassign only the ones specified in the signed request.
  const headers = req.signedRequest.headers;
  Object.keys(headers).forEach((key) => {
    manager.removeHeader(key);
  });
  Object.entries(req.signedRequest.headers).forEach(([key, value]) => {
    manager.setHeader(key, value);
  });
  const serialized =
    typeof req.signedRequest.body === "string"
      ? req.signedRequest.body
      : JSON.stringify(req.signedRequest.body);
  manager.setHeader("Content-Length", String(Buffer.byteLength(serialized)));
  manager.setBody(serialized);
};
