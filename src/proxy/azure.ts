import { RequestHandler, Router } from "express";
import { config } from "../config";
import { generateModelList } from "./openai";
import { ipLimiter } from "./rate-limit";
import {
  addAzureKey,
  createPreprocessorMiddleware,
  finalizeSignedRequest,
} from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

let modelsCache: any = null;
let modelsCacheTime = 0;

const handleModelRequest: RequestHandler = (_req, res) => {
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return res.status(200).json(modelsCache);
  }

  if (!config.azureCredentials) return { object: "list", data: [] };

  const result = generateModelList("azure");

  modelsCache = { object: "list", data: result };
  modelsCacheTime = new Date().getTime();
  res.status(200).json(modelsCache);
};

const azureOpenaiResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  res.status(200).json({ ...body, proxy: body.proxy });
};

const azureOpenAIProxy = createQueuedProxyMiddleware({
  target: ({ signedRequest }) => {
    if (!signedRequest) throw new Error("Must sign request before proxying");
    const { hostname, protocol } = signedRequest;
    return `${protocol}//${hostname}`;
  },
  mutations: [addAzureKey, finalizeSignedRequest],
  blockingResponseHandler: azureOpenaiResponseHandler,
});


const azureOpenAIRouter = Router();
azureOpenAIRouter.get("/v1/models", handleModelRequest);
azureOpenAIRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai",
    outApi: "openai",
    service: "azure",
  }),
  azureOpenAIProxy
);
azureOpenAIRouter.post(
  "/v1/images/generations",
  ipLimiter,
  createPreprocessorMiddleware({
    inApi: "openai-image",
    outApi: "openai-image",
    service: "azure",
  }),
  azureOpenAIProxy
);

export const azure = azureOpenAIRouter;
