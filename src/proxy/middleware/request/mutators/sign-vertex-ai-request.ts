import { AnthropicV1MessagesSchema } from "../../../../shared/api-schemas";
import { GcpKey, keyPool } from "../../../../shared/key-management";
import { ProxyReqMutator } from "../index";
import {
  getCredentialsFromGcpKey,
  refreshGcpAccessToken,
} from "../../../../shared/key-management/gcp/oauth";

const GCP_HOST = process.env.GCP_HOST || "%REGION%-aiplatform.googleapis.com";

export const signGcpRequest: ProxyReqMutator = async (manager) => {
  const req = manager.request;
  const serviceValid = req.service === "gcp";
  if (!serviceValid) {
    throw new Error("addVertexAIKey called on invalid request");
  }

  if (!req.body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  const { model } = req.body;
  const key: GcpKey = keyPool.get(model, "gcp") as GcpKey;

  if (!key.accessToken || Date.now() > key.accessTokenExpiresAt) {
    const [token, durationSec] = await refreshGcpAccessToken(key);
    keyPool.update(key, {
      accessToken: token,
      accessTokenExpiresAt: Date.now() + durationSec * 1000 * 0.95,
    } as GcpKey);
    // nb: key received by `get` is a clone and will not have the new access
    // token we just set, so it must be manually updated.
    key.accessToken = token;
  }

  manager.setKey(key);
  req.log.info({ key: key.hash, model }, "Assigned GCP key to request");

  // TODO: This should happen in transform-outbound-payload.ts
  // TODO: Support tools
  let strippedParams: Record<string, unknown>;
  strippedParams = AnthropicV1MessagesSchema.pick({
    messages: true,
    system: true,
    max_tokens: true,
    stop_sequences: true,
    temperature: true,
    top_k: true,
    top_p: true,
    stream: true,
    tools: true,
    tool_choice: true,
    thinking: true
  })
    .strip()
    .parse(req.body);
  strippedParams.anthropic_version = "vertex-2023-10-16";

  const credential = await getCredentialsFromGcpKey(key);

  const host = GCP_HOST.replace("%REGION%", credential.region);
  // GCP doesn't use the anthropic-version header, but we set it to ensure the
  // stream adapter selects the correct transformer.
  manager.setHeader("anthropic-version", "2023-06-01");

  manager.setSignedRequest({
    method: "POST",
    protocol: "https:",
    hostname: host,
    path: `/v1/projects/${credential.projectId}/locations/${credential.region}/publishers/anthropic/models/${model}:streamRawPredict`,
    headers: {
      ["host"]: host,
      ["content-type"]: "application/json",
      ["authorization"]: `Bearer ${key.accessToken}`,
    },
    body: JSON.stringify(strippedParams),
  });
};
