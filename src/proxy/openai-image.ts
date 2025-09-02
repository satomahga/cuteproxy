import { Request, RequestHandler, Router } from "express";
import { OpenAIImageGenerationResult } from "../shared/file-storage/mirror-generated-image";
import { generateModelList } from "./openai";
import { ipLimiter } from "./rate-limit";
import {
  addKey,
  createPreprocessorMiddleware,
  finalizeBody,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

const KNOWN_MODELS = ["dall-e-2", "dall-e-3", "gpt-image-1"];

let modelListCache: any = null;
let modelListValid = 0;
const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelListValid < 1000 * 60) {
    return res.status(200).json(modelListCache);
  }
  const result = generateModelList("openai").filter((m: { id: string }) =>
    KNOWN_MODELS.includes(m.id)
  );
  modelListCache = { object: "list", data: result };
  modelListValid = new Date().getTime();
  res.status(200).json(modelListCache);
};

const openaiImagesResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  if (req.inboundApi === "openai") {
    req.log.info("Transforming OpenAI image response to OpenAI chat format");
    newBody = transformResponseForChat(
      body as OpenAIImageGenerationResult,
      req
    );
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

/**
 * Transforms a DALL-E image generation response into a chat response, simply
 * embedding the image URL into the chat message as a Markdown image.
 */
function transformResponseForChat(
  imageBody: OpenAIImageGenerationResult,
  req: Request
): Record<string, any> {
  const prompt = imageBody.data[0].revised_prompt ?? req.body.prompt;
  const isGptImage = req.body.model?.includes("gpt-image") || false;
  
  const content = imageBody.data
    .map((item) => {
      const { url, b64_json } = item;
      // The gpt-image-1 model always returns b64_json
      // Format will depend on output_format parameter (defaults to png)
      // For simplicity, we'll assume png if not specified
      const format = req.body.output_format || "png";
      
      if (b64_json) {
        return `![${prompt}](data:image/${format};base64,${b64_json})`;
      } else {
        return `![${prompt}](${url})`;
      }
    })
    .join("\n\n");

  // Prepare the usage information - gpt-image-1 includes detailed token usage
  let usage = {
    prompt_tokens: 0,
    completion_tokens: req.outputTokens,
    total_tokens: req.outputTokens,
  };
  
  // If this is a gpt-image-1 response, it includes detailed usage info
  if (imageBody.usage) {
    usage = {
      prompt_tokens: imageBody.usage.input_tokens || 0,
      completion_tokens: imageBody.usage.output_tokens || 0,
      total_tokens: imageBody.usage.total_tokens || 0,
    };
  }
  
  return {
    id: req.body.model?.includes("gpt-image") ? "gptimage-" + req.id : "dalle-" + req.id,
    object: "chat.completion",
    created: Date.now(),
    model: req.body.model,
    usage,
    choices: [
      {
        message: { role: "assistant", content },
        finish_reason: "stop",
        index: 0,
      },
    ],
  };
}

// Filter parameters based on the model being used to avoid sending unsupported parameters
function filterModelParameters(manager: ProxyReqManager) {
  const req = manager.request;
  const originalBody = req.body;
  const modelName = originalBody?.model || "";
  
  // Skip if no body or it's not an object
  if (!originalBody || typeof originalBody !== 'object') return;
  
  // Create a deep copy of the body to filter
  const filteredBody = { ...originalBody };
  
  // Define allowed parameters for each model
  if (modelName.includes('dall-e-2')) {
    // DALL-E 2 parameters
    const allowedParams = [
      'model', 'prompt', 'n', 'size', 'response_format', 'user'
    ];
    
    // Remove any parameter not in the allowed list
    Object.keys(filteredBody).forEach(key => {
      if (!allowedParams.includes(key)) {
        delete filteredBody[key];
      }
    });
    
    req.log.info({ model: 'dall-e-2', params: Object.keys(filteredBody) }, "Filtered parameters for DALL-E 2");
  } else if (modelName.includes('dall-e-3')) {
    // DALL-E 3 parameters
    const allowedParams = [
      'model', 'prompt', 'n', 'quality', 'size', 'style', 'response_format', 'user'
    ];
    
    // Remove any parameter not in the allowed list
    Object.keys(filteredBody).forEach(key => {
      if (!allowedParams.includes(key)) {
        delete filteredBody[key];
      }
    });
    
    req.log.info({ model: 'dall-e-3', params: Object.keys(filteredBody) }, "Filtered parameters for DALL-E 3");
  } else if (modelName.includes('gpt-image')) {
    // Define allowed parameters for gpt-image-1
    const allowedParams = [
      'model', 'prompt', 'background', 'moderation', 'n', 'output_compression',
      'output_format', 'quality', 'size', 'user', 'image', 'mask'
    ];
    
    // Remove any parameter not in the allowed list, especially 'style' which is only for DALL-E 3
    Object.keys(filteredBody).forEach(key => {
      if (!allowedParams.includes(key)) {
        req.log.info({ model: 'gpt-image-1', removedParam: key }, "Removing unsupported parameter for GPT Image");
        delete filteredBody[key];
      }
    });
    
    req.log.info({ model: 'gpt-image-1', params: Object.keys(filteredBody) }, "Filtered parameters for GPT Image");
  }
  
  // Use the proper method to update the body
  manager.setBody(filteredBody);
}

function replacePath(manager: ProxyReqManager) {
  const req = manager.request;
  const pathname = req.url.split("?")[0];
  req.log.debug({ pathname }, "OpenAI image path filter");
  if (req.path.startsWith("/v1/chat/completions")) {
    manager.setPath("/v1/images/generations");
  }
}

const openaiImagesProxy = createQueuedProxyMiddleware({
  target: "https://api.openai.com",
  mutations: [replacePath, filterModelParameters, addKey, finalizeBody],
  blockingResponseHandler: openaiImagesResponseHandler,
});

const openaiImagesRouter = Router();
openaiImagesRouter.get("/v1/models", handleModelRequest);
openaiImagesRouter.post(
  "/v1/images/generations",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-image",
    outApi: "openai-image",
    service: "openai",
  }),
  openaiImagesProxy
);
// Add support for the /v1/images/edits endpoint (used by gpt-image-1 for image editing)
openaiImagesRouter.post(
  "/v1/images/edits",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-image",
    outApi: "openai-image",
    service: "openai",
  }),
  openaiImagesProxy
);
openaiImagesRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai",
    outApi: "openai-image",
    service: "openai",
  }),
  openaiImagesProxy
);
export const openaiImage = openaiImagesRouter;
