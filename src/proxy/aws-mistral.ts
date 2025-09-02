import { Request, Router } from "express";
import {
  detectMistralInputApi,
  transformMistralTextToMistralChat,
} from "./mistral-ai";
import { ipLimiter } from "./rate-limit";
import { ProxyResHandlerWithBody } from "./middleware/response";
import {
  createPreprocessorMiddleware,
  finalizeSignedRequest,
  signAwsRequest,
} from "./middleware/request";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

const awsMistralBlockingResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;
  if (req.inboundApi === "mistral-ai" && req.outboundApi === "mistral-text") {
    newBody = transformMistralTextToMistralChat(body);
  }
  // AWS does not always confirm the model in the response, so we have to add it
  if (!newBody.model && req.body.model) {
    newBody.model = req.body.model;
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const awsMistralProxy = createQueuedProxyMiddleware({
  target: ({ signedRequest }) => {
    if (!signedRequest) throw new Error("Must sign request before proxying");
    return `${signedRequest.protocol}//${signedRequest.hostname}`;
  },
  mutations: [signAwsRequest,finalizeSignedRequest],
  blockingResponseHandler: awsMistralBlockingResponseHandler,
});

function maybeReassignModel(req: Request) {
  const model = req.body.model;

  // If it looks like an AWS model, use it as-is
  if (model.startsWith("mistral.")) {
    return;
  }
  // Mistral 7B Instruct
  else if (model.includes("7b")) {
    req.body.model = "mistral.mistral-7b-instruct-v0:2";
  }
  // Mistral 8x7B Instruct
  else if (model.includes("8x7b")) {
    req.body.model = "mistral.mixtral-8x7b-instruct-v0:1";
  }
  // Mistral Large (Feb 2024)
  else if (model.includes("large-2402")) {
    req.body.model = "mistral.mistral-large-2402-v1:0";
  }
  // Mistral Large 2 (July 2024)
  else if (model.includes("large")) {
    req.body.model = "mistral.mistral-large-2407-v1:0";
  }
  // Mistral Small (Feb 2024)
  else if (model.includes("small")) {
    req.body.model = "mistral.mistral-small-2402-v1:0";
  } else {
    throw new Error(
      `Can't map '${model}' to a supported AWS model ID; make sure you are requesting a Mistral model supported by Amazon Bedrock`
    );
  }
}

const nativeMistralChatPreprocessor = createPreprocessorMiddleware(
  { inApi: "mistral-ai", outApi: "mistral-ai", service: "aws" },
  {
    beforeTransform: [detectMistralInputApi],
    afterTransform: [maybeReassignModel],
  }
);

const awsMistralRouter = Router();
awsMistralRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  nativeMistralChatPreprocessor,
  awsMistralProxy
);

export const awsMistral = awsMistralRouter;
