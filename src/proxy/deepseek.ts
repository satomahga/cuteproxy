import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { DeepseekKey, keyPool } from "../shared/key-management";

let modelsCache: any = null;
let modelsCacheTime = 0;

const deepseekResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  try {
    // Get a Deepseek key directly using keyPool.get()
    const modelToUse = "deepseek-chat"; // Use any Deepseek model here - just for key selection
    const deepseekKey = keyPool.get(modelToUse, "deepseek") as DeepseekKey;
    
    if (!deepseekKey || !deepseekKey.key) {
      throw new Error("Failed to get valid Deepseek key");
    }

    // Fetch models from Deepseek API with authorization
    const response = await axios.get("https://api.deepseek.com/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${deepseekKey.key}`
      },
    });

    // If successful, update the cache
    if (response.data && response.data.data) {
      modelsCache = {
        object: "list",
        data: response.data.data.map((model: any) => ({
          id: model.id,
          object: "model",
          owned_by: "deepseek",
        })),
      };
    } else {
      throw new Error("Unexpected response format from Deepseek API");
    }
  } catch (error) {
    console.error("Error fetching Deepseek models:", error);
    throw error; // No fallback - error will be passed to caller
  }

  modelsCacheTime = new Date().getTime();
  return modelsCache;
};

const handleModelRequest: RequestHandler = async (_req, res) => {
  try {
    const modelsResponse = await getModelsResponse();
    res.status(200).json(modelsResponse);
  } catch (error) {
    console.error("Error in handleModelRequest:", error);
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

const deepseekProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://api.deepseek.com/beta",
  blockingResponseHandler: deepseekResponseHandler,
});

const deepseekRouter = Router();

// combines all the assistant messages at the end of the context and adds the
// beta 'prefix' option, makes prefills work the same way they work for Claude
function enablePrefill(req: Request) {
  // If you want to disable
  if (process.env.NO_DEEPSEEK_PREFILL) return
  
  const msgs = req.body.messages;
  if (msgs.at(-1)?.role !== 'assistant') return;

  let i = msgs.length - 1;
  let content = '';
  
  while (i >= 0 && msgs[i].role === 'assistant') {
    // maybe we should also add a newline between messages? no for now.
    content = msgs[i--].content + content;
  }
  
  msgs.splice(i + 1, msgs.length, { role: 'assistant', content, prefix: true });
}

deepseekRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "deepseek" },
    { afterTransform: [ enablePrefill ] }
  ),
  deepseekProxy
);

deepseekRouter.get("/v1/models", handleModelRequest);

export const deepseek = deepseekRouter;