/* Shared code between AWS Claude and AWS Mistral endpoints. */

import { Request, Response, Router } from "express";
import { config } from "../config";
import { addV1 } from "./add-v1";
import { awsClaude } from "./aws-claude";
import { awsMistral } from "./aws-mistral";
import { AwsBedrockKey, keyPool } from "../shared/key-management";
import { claudeModels, findByAwsId } from "../shared/claude-models";

const awsRouter = Router();
awsRouter.get(["/:vendor?/v1/models", "/:vendor?/models"], handleModelsRequest);
awsRouter.use("/claude", addV1, awsClaude);
awsRouter.use("/mistral", addV1, awsMistral);

const MODELS_CACHE_TTL = 10000;
let modelsCache: Record<string, any> = {};
let modelsCacheTime: Record<string, number> = {};
function handleModelsRequest(req: Request, res: Response) {
  if (!config.awsCredentials) return { object: "list", data: [] };

  const vendor = req.params.vendor?.length
    ? req.params.vendor === "claude"
      ? "anthropic"
      : req.params.vendor
    : "all";

  const cacheTime = modelsCacheTime[vendor] || 0;
  if (new Date().getTime() - cacheTime < MODELS_CACHE_TTL) {
    return res.json(modelsCache[vendor]);
  }

  const availableAwsModelIds = new Set<string>();
  for (const key of keyPool.list()) {
    if (key.isDisabled || key.service !== "aws") continue;
    (key as AwsBedrockKey).modelIds.forEach((id) => availableAwsModelIds.add(id));
  }

  const mistralMappings = new Map([
    ["mistral.mistral-7b-instruct-v0:2", "Mistral 7B Instruct"],
    ["mistral.mixtral-8x7b-instruct-v0:1", "Mixtral 8x7B Instruct"],
    ["mistral.mistral-large-2402-v1:0", "Mistral Large 2402"],
    ["mistral.mistral-large-2407-v1:0", "Mistral Large 2407"],
    ["mistral.mistral-small-2402-v1:0", "Mistral Small 2402"],
  ]);

  const date = new Date();
  
  const claudeModelsList = claudeModels
    .filter(model => availableAwsModelIds.has(model.awsId))
    .map(model => ({
      id: model.anthropicId,
      owned_by: "anthropic",
      type: "model",
      display_name: model.displayName,
      created_at: date.toISOString(),
      object: "model",
      created: date.getTime(),
      permission: [],
      root: "anthropic",
      parent: null,
    }));
    
  const mistralModelsList = Array.from(mistralMappings.keys())
    .filter(id => availableAwsModelIds.has(id))
    .map(id => {
      return {
        id,
        owned_by: "mistral",
        type: "model",
        display_name: mistralMappings.get(id) || id.split('.')[1],
        created_at: date.toISOString(),
        object: "model",
        created: date.getTime(),
        permission: [],
        root: "mistral",
        parent: null,
      };
    });

  const allModels = [...claudeModelsList, ...mistralModelsList];
  const filteredModels = vendor === "all" 
    ? allModels 
    : allModels.filter(m => m.root === vendor);

  modelsCache[vendor] = {
    object: "list",
    data: filteredModels,
    has_more: false,
    first_id: filteredModels[0]?.id,
    last_id: filteredModels[filteredModels.length - 1]?.id,
  };
  modelsCacheTime[vendor] = date.getTime();

  return res.json(modelsCache[vendor]);
}

export const aws = awsRouter;
