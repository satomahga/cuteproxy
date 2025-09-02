import { AnthropicChatMessage } from "../../../../shared/api-schemas";
import { containsImageContent } from "../../../../shared/api-schemas/anthropic";
import { Key, OpenAIKey, keyPool } from "../../../../shared/key-management";
import { isEmbeddingsRequest } from "../../common";
import { assertNever } from "../../../../shared/utils";
import { ProxyReqMutator } from "../index";

export const addKey: ProxyReqMutator = (manager) => {
  const req = manager.request;

  let assignedKey: Key;
  const { service, inboundApi, outboundApi, body } = req;

  if (!inboundApi || !outboundApi) {
    const err = new Error(
      "Request API format missing. Did you forget to add the request preprocessor to your router?"
    );
    req.log.error({ inboundApi, outboundApi, path: req.path }, err.message);
    throw err;
  }

  if (!body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  let needsMultimodal = false;
  if (outboundApi === "anthropic-chat") {
    needsMultimodal = containsImageContent(
      body.messages as AnthropicChatMessage[]
    );
  }

  if (inboundApi === outboundApi) {
    // Pass streaming information for GPT-5 models that require verified keys for streaming
    const isStreaming = body.stream === true;
    assignedKey = keyPool.get(body.model, service, needsMultimodal, isStreaming);
  } else {
    switch (outboundApi) {
      // If we are translating between API formats we may need to select a model
      // for the user, because the provided model is for the inbound API.
      // TODO: This whole else condition is probably no longer needed since API
      // translation now reassigns the model earlier in the request pipeline.
      case "anthropic-text":
      case "anthropic-chat":
      case "mistral-ai":
      case "mistral-text":
      case "google-ai":
        assignedKey = keyPool.get(body.model, service);
        break;
      case "openai-text":
        assignedKey = keyPool.get("gpt-3.5-turbo-instruct", service);
        break;
      case "openai-image":
        // Use the actual model from the request body instead of defaulting to dall-e-3
        // This ensures that gpt-image-1 requests get keys that are verified for gpt-image-1
        assignedKey = keyPool.get(body.model, service);
        break;
      case "openai-responses":
        assignedKey = keyPool.get(body.model, service);
        break;
      case "openai":
        throw new Error(
          `Outbound API ${outboundApi} is not supported for ${inboundApi}`
        );
      default:
        assertNever(outboundApi);
    }
  }

  manager.setKey(assignedKey);
  req.log.info(
    { key: assignedKey.hash, model: body.model, inboundApi, outboundApi },
    "Assigned key to request"
  );

  // TODO: KeyProvider should assemble all necessary headers
  switch (assignedKey.service) {
    case "anthropic":
      manager.setHeader("X-API-Key", assignedKey.key);
      if (!manager.request.headers["anthropic-version"]) {
        manager.setHeader("anthropic-version", "2023-06-01");
      }
      break;
    case "openai":
      const key: OpenAIKey = assignedKey as OpenAIKey;
      if (key.organizationId && !key.key.includes("svcacct")) {
        manager.setHeader("OpenAI-Organization", key.organizationId);
      }
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "mistral-ai":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "azure":
      const azureKey = assignedKey.key;
      manager.setHeader("api-key", azureKey);
      break;
    case "deepseek":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "xai":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "cohere":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "qwen":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "moonshot":
      manager.setHeader("Authorization", `Bearer ${assignedKey.key}`);
      break;
    case "aws":
    case "gcp":
    case "google-ai":
      throw new Error("add-key should not be used for this service.");
    default:
      assertNever(assignedKey.service);
  }
};

/**
 * Special case for embeddings requests which don't go through the normal
 * request pipeline.
 */
export const addKeyForEmbeddingsRequest: ProxyReqMutator = (manager) => {
  const req = manager.request;
  if (!isEmbeddingsRequest(req)) {
    throw new Error(
      "addKeyForEmbeddingsRequest called on non-embeddings request"
    );
  }

  if (req.inboundApi !== "openai") {
    throw new Error("Embeddings requests must be from OpenAI");
  }

  manager.setBody({ input: req.body.input, model: "text-embedding-ada-002" });

  const key = keyPool.get("text-embedding-ada-002", "openai") as OpenAIKey;

  manager.setKey(key);
  req.log.info(
    { key: key.hash, toApi: req.outboundApi },
    "Assigned Turbo key to embeddings request"
  );

  manager.setHeader("Authorization", `Bearer ${key.key}`);
  if (key.organizationId) {
    manager.setHeader("OpenAI-Organization", key.organizationId);
  }
};
