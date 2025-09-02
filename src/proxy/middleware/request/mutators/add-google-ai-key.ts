import { keyPool } from "../../../../shared/key-management";
import { ProxyReqMutator } from "../index";

export const addGoogleAIKey: ProxyReqMutator = (manager) => {
  const req = manager.request;
  const inboundValid =
    req.inboundApi === "openai" || req.inboundApi === "google-ai";
  const outboundValid = req.outboundApi === "google-ai";

  const serviceValid = req.service === "google-ai";
  if (!inboundValid || !outboundValid || !serviceValid) {
    throw new Error("addGoogleAIKey called on invalid request");
  }

  const model = req.body.model;
  const key = keyPool.get(model, "google-ai");
  manager.setKey(key);

  req.log.info(
    { key: key.hash, model, stream: req.isStreaming },
    "Assigned Google AI API key to request"
  );

  // https://generativelanguage.googleapis.com/v1beta/models/$MODEL_ID:generateContent?key=$API_KEY
  // https://generativelanguage.googleapis.com/v1beta/models/$MODEL_ID:streamGenerateContent?key=${API_KEY}
  const payload = { ...req.body, stream: undefined, model: undefined };

  // For OpenAI -> Google conversion we don't actually have the API version
  const apiVersion = req.params.apiVersion || "v1beta"

  // TODO: this isn't actually signed, so the manager api is a little unclear
  // with the ProxyReqManager refactor, it's probably no longer necesasry to
  // do this because we can modify the path using Manager.setPath.
  manager.setSignedRequest({
    method: "POST",
    protocol: "https:",
    hostname: "generativelanguage.googleapis.com",
    path: `/${apiVersion}/models/${model}:${
      req.isStreaming ? "streamGenerateContent?alt=sse&" : "generateContent?"
    }key=${key.key}`,
    headers: {
      ["host"]: `generativelanguage.googleapis.com`,
      ["content-type"]: "application/json",
    },
    body: JSON.stringify(payload),
  });
};
