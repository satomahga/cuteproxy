// Don't import any other project files here as this is one of the first modules
// loaded and it will cause circular imports.

import type { Request } from "express";

/**
 * The service that a model is hosted on. Distinct from `APIFormat` because some
 * services have interoperable APIs (eg Anthropic/AWS/GCP, OpenAI/Azure).
 */
export type LLMService =
  | "openai"
  | "anthropic"
  | "google-ai"
  | "mistral-ai"
  | "aws"
  | "gcp"
  | "azure"
  | "deepseek"
  | "xai"
  | "cohere"
  | "qwen"
  | "moonshot";

export type OpenAIModelFamily =
  | "turbo"
  | "gpt4"
  | "gpt4-32k"
  | "gpt4-turbo"
  | "gpt4o"
  | "gpt41"
  | "gpt41-mini"
  | "gpt41-nano"
  | "gpt45"
  | "gpt5"
  | "gpt5-mini"
  | "gpt5-nano"
  | "gpt5-chat-latest"
  | "o1"
  | "o1-mini"
  | "o1-pro"
  | "o3-pro"
  | "o3-mini"
  | "o3"
  | "o4-mini"
  | "codex-mini"
  | "dall-e"
  | "gpt-image";
export type AnthropicModelFamily = "claude" | "claude-opus";
export type GoogleAIModelFamily =
  | "gemini-flash"
  | "gemini-pro"
  | "gemini-ultra";
export type MistralAIModelFamily =
  // mistral changes their model classes frequently so these no longer
  // correspond to specific models. consider them rough pricing tiers.
  "mistral-tiny" | "mistral-small" | "mistral-medium" | "mistral-large";
export type AwsBedrockModelFamily = `aws-${
  | AnthropicModelFamily
  | MistralAIModelFamily}`;
export type GcpModelFamily = "gcp-claude" | "gcp-claude-opus";
export type AzureOpenAIModelFamily = `azure-${OpenAIModelFamily}`;
export type DeepseekModelFamily = "deepseek";
export type XaiModelFamily = "xai";
export type CohereModelFamily = "cohere";
export type QwenModelFamily = "qwen";
export type MoonshotModelFamily = "moonshot";

export type ModelFamily =
  | OpenAIModelFamily
  | AnthropicModelFamily
  | GoogleAIModelFamily
  | MistralAIModelFamily
  | AwsBedrockModelFamily
  | GcpModelFamily
  | AzureOpenAIModelFamily
  | DeepseekModelFamily
  | XaiModelFamily
  | CohereModelFamily
  | QwenModelFamily
  | MoonshotModelFamily;

export const MODEL_FAMILIES = (<A extends readonly ModelFamily[]>(
  arr: A & ([ModelFamily] extends [A[number]] ? unknown : never)
) => arr)([
  "moonshot",
  "qwen",
  "cohere",
  "xai",
  "deepseek",
  "turbo",
  "gpt4",
  "gpt4-32k",
  "gpt4-turbo",
  "gpt4o",
  "gpt45",
  "gpt41",
  "gpt41-mini",
  "gpt41-nano",
  "gpt5",
  "gpt5-mini",
  "gpt5-nano",
  "gpt5-chat-latest",
  "o1",
  "o1-mini",
  "o1-pro",
  "o3-pro",
  "o3-mini",
  "o3",
  "o4-mini",
  "codex-mini",
  "dall-e",
  "gpt-image",
  "claude",
  "claude-opus",
  "gemini-flash",
  "gemini-pro",
  "gemini-ultra",
  "mistral-tiny",
  "mistral-small",
  "mistral-medium",
  "mistral-large",
  "aws-claude",
  "aws-claude-opus",
  "aws-mistral-tiny",
  "aws-mistral-small",
  "aws-mistral-medium",
  "aws-mistral-large",
  "gcp-claude",
  "gcp-claude-opus",
  "azure-turbo",
  "azure-gpt4",
  "azure-gpt4-32k",
  "azure-gpt4-turbo",
  "azure-gpt4o",
  "azure-gpt45",
  "azure-gpt41",
  "azure-gpt41-mini",
  "azure-gpt41-nano",
  "azure-gpt5",
  "azure-gpt5-mini",
  "azure-gpt5-nano",
  "azure-gpt5-chat-latest",
  "azure-dall-e",
  "azure-o1",
  "azure-o1-mini",
  "azure-o1-pro",
  "azure-o3-pro",
  "azure-o3-mini",
  "azure-o3",
  "azure-o4-mini",
  "azure-codex-mini",
  "azure-gpt-image",
] as const);

export const LLM_SERVICES = (<A extends readonly LLMService[]>(
  arr: A & ([LLMService] extends [A[number]] ? unknown : never)
) => arr)([
  "openai",
  "anthropic",
  "google-ai",
  "mistral-ai",
  "aws",
  "gcp",
  "azure",
  "deepseek",
  "xai",
  "cohere",
  "qwen",
  "moonshot"
] as const);

export const MODEL_FAMILY_SERVICE: {
  [f in ModelFamily]: LLMService;
} = {
  moonshot: "moonshot",
  qwen: "qwen",
  cohere: "cohere",
  xai: "xai",
  deepseek: "deepseek",
  turbo: "openai",
  gpt4: "openai",
  "gpt4-turbo": "openai",
  "gpt4-32k": "openai",
  gpt4o: "openai",
  gpt45: "openai",
  gpt41: "openai",
  "gpt41-mini": "openai",
  "gpt41-nano": "openai",
  gpt5: "openai",
  "gpt5-mini": "openai",
  "gpt5-nano": "openai",
  "gpt5-chat-latest": "openai",
  "o1": "openai",
  "o1-mini": "openai",
  "o1-pro": "openai",
  "o3-pro": "openai",
  "o3-mini": "openai",
  "o3": "openai",
  "o4-mini": "openai",
  "codex-mini": "openai",
  "dall-e": "openai",
  "gpt-image": "openai",
  claude: "anthropic",
  "claude-opus": "anthropic",
  "aws-claude": "aws",
  "aws-claude-opus": "aws",
  "aws-mistral-tiny": "aws",
  "aws-mistral-small": "aws",
  "aws-mistral-medium": "aws",
  "aws-mistral-large": "aws",
  "gcp-claude": "gcp",
  "gcp-claude-opus": "gcp",
  "azure-turbo": "azure",
  "azure-gpt4": "azure",
  "azure-gpt4-32k": "azure",
  "azure-gpt4-turbo": "azure",
  "azure-gpt4o": "azure",
  "azure-gpt45": "azure",
  "azure-gpt41": "azure",
  "azure-gpt41-mini": "azure",
  "azure-gpt41-nano": "azure",
  "azure-gpt5": "azure",
  "azure-gpt5-mini": "azure",
  "azure-gpt5-nano": "azure",
  "azure-gpt5-chat-latest": "azure",
  "azure-dall-e": "azure",
  "azure-o1": "azure",
  "azure-o1-mini": "azure",
  "azure-o1-pro": "azure",
  "azure-o3-pro": "azure",
  "azure-o3-mini": "azure",
  "azure-o3": "azure",
  "azure-o4-mini": "azure",
  "azure-codex-mini": "azure",
  "azure-gpt-image": "azure",
  "gemini-flash": "google-ai",
  "gemini-pro": "google-ai",
  "gemini-ultra": "google-ai",
  "mistral-tiny": "mistral-ai",
  "mistral-small": "mistral-ai",
  "mistral-medium": "mistral-ai",
  "mistral-large": "mistral-ai",
};

export const IMAGE_GEN_MODELS: ModelFamily[] = ["dall-e", "azure-dall-e", "gpt-image", "azure-gpt-image", "gemini-flash"];

export const OPENAI_MODEL_FAMILY_MAP: { [regex: string]: OpenAIModelFamily } = {
  "^gpt-image(-\\d+)?(-preview)?(-\\d{4}-\\d{2}-\\d{2})?$": "gpt-image",
  "^gpt-5(-\\d{4}-\\d{2}-\\d{2})?$": "gpt5",
  "^gpt-5-mini(-\\d{4}-\\d{2}-\\d{2})?$": "gpt5-mini",
  "^gpt-5-nano(-\\d{4}-\\d{2}-\\d{2})?$": "gpt5-nano",
  "^gpt-5-chat-latest(-\\d{4}-\\d{2}-\\d{2})?$": "gpt5-chat-latest",
  "^gpt-4\\.5(-preview)?(-\\d{4}-\\d{2}-\\d{2})?$": "gpt45",
  "^gpt-4\\.1(-\\d{4}-\\d{2}-\\d{2})?$": "gpt41",
  "^gpt-4\\.1-mini(-\\d{4}-\\d{2}-\\d{2})?$": "gpt41-mini",
  "^gpt-4\\.1-nano(-\\d{4}-\\d{2}-\\d{2})?$": "gpt41-nano",
  "^gpt-4o(-\\d{4}-\\d{2}-\\d{2})?$": "gpt4o",
  "^chatgpt-4o": "gpt4o",
  "^gpt-4o-mini(-\\d{4}-\\d{2}-\\d{2})?$": "turbo", // closest match
  "^gpt-4-turbo(-\\d{4}-\\d{2}-\\d{2})?$": "gpt4-turbo",
  "^gpt-4-turbo(-preview)?$": "gpt4-turbo",
  "^gpt-4-(0125|1106)(-preview)?$": "gpt4-turbo",
  "^gpt-4(-\\d{4})?-vision(-preview)?$": "gpt4-turbo",
  "^gpt-4-32k-\\d{4}$": "gpt4-32k",
  "^gpt-4-32k$": "gpt4-32k",
  "^gpt-4-\\d{4}$": "gpt4",
  "^gpt-4$": "gpt4",
  "^gpt-3.5-turbo": "turbo",
  "^text-embedding-ada-002$": "turbo",
  "^dall-e-\\d{1}$": "dall-e",
  "^o1-mini(-\\d{4}-\\d{2}-\\d{2})?$": "o1-mini",
  "^o1-pro(-\\d{4}-\\d{2}-\\d{2})?$": "o1-pro",
  "^o3-pro(-\\d{4}-\\d{2}-\\d{2})?$": "o3-pro",
  "^o1(-\\d{4}-\\d{2}-\\d{2})?$": "o1",
  "^o3-mini(-\\d{4}-\\d{2}-\\d{2})?$": "o3-mini",
  "^o3(-\\d{4}-\\d{2}-\\d{2})?$": "o3",
  "^o4-mini(-\\d{4}-\\d{2}-\\d{2})?$": "o4-mini",
  "^codex-mini(-latest|-\d{4}-\d{2}-\d{2})?$": "codex-mini",
};

export function getOpenAIModelFamily(
  model: string,
  defaultFamily: OpenAIModelFamily = "gpt4"
): OpenAIModelFamily {
  for (const [regex, family] of Object.entries(OPENAI_MODEL_FAMILY_MAP)) {
    if (model.match(regex)) return family;
  }
  return defaultFamily;
}

export function getClaudeModelFamily(model: string): AnthropicModelFamily {
  if (model.includes("opus")) return "claude-opus";
  return "claude";
}

export function getGoogleAIModelFamily(model: string): GoogleAIModelFamily {
  // Treat models as Gemini Ultra only if they include "ultra" and are NOT Imagen models
  return model.includes("ultra") && !model.includes("imagen")
    ? "gemini-ultra"
    : model.includes("flash")
    ? "gemini-flash"
    : "gemini-pro";
}

export function getMistralAIModelFamily(model: string): MistralAIModelFamily {
  const prunedModel = model.replace(/-(latest|\d{4}(-\d{2}){0,2})$/, "");
  
  // Premier models (higher tier)
  switch (prunedModel) {
    // Existing direct matches
    case "mistral-tiny":
    case "mistral-small":
    case "mistral-medium":
    case "mistral-large":
      return prunedModel as MistralAIModelFamily;
      
    // Premier models - Large tier
    case "mistral-large":
    case "pixtral-large":
      return "mistral-large";
      
    // Premier models - Medium tier
    case "mistral-medium-2505":
    case "magistral-medium-latest":
      return "mistral-medium";
      
    // Premier models - Small tier
    case "codestral":
    case "ministral-8b":
    case "mistral-embed":
    case "pixtral-12b-2409":
    case "magistral-small-latest":
      return "mistral-small";
    
    // Premier models - Tiny tier
    case "ministral-3b":
      return "mistral-tiny";
      
    // Free models - Tiny tier
    case "open-mistral-7b":
      return "mistral-tiny";
      
    // Free models - Small tier
    case "mistral-small":
    case "pixtral":
    case "pixtral-12b":
    case "open-mistral-nemo":
    case "open-mixtral-8x7b":
    case "open-codestral-mamba":
    case "mathstral":
      return "mistral-small";
    
    // Free models - Medium tier
    case "open-mixtral-8x22b":
      return "mistral-medium";
      
    // Default to small if unknown
    default:
      return "mistral-small";
  }
}

export function getAwsBedrockModelFamily(model: string): AwsBedrockModelFamily {
  // remove vendor and version from AWS model ids
  // 'anthropic.claude-3-5-sonnet-20240620-v1:0' -> 'claude-3-5-sonnet-20240620'
  const deAwsified = model.replace(/^(\w+)\.(.+?)(-v\d+)?(:\d+)*$/, "$2");

  if (["claude", "anthropic"].some((x) => model.includes(x))) {
    return `aws-${getClaudeModelFamily(deAwsified)}`;
  } else if (model.includes("tral")) {
    return `aws-${getMistralAIModelFamily(deAwsified)}`;
  }
  return `aws-claude`;
}

export function getGcpModelFamily(model: string): GcpModelFamily {
  if (model.includes("opus")) return "gcp-claude-opus";
  return "gcp-claude";
}

export function getAzureOpenAIModelFamily(
  model: string,
  defaultFamily: AzureOpenAIModelFamily = "azure-gpt4"
): AzureOpenAIModelFamily {
  // Azure model names omit periods.  addAzureKey also prepends "azure-" to the
  // model name to route the request the correct keyprovider, so we need to
  // remove that as well.
  const modified = model
    .replace("gpt-35-turbo", "gpt-3.5-turbo")
    .replace("azure-", "");
  for (const [regex, family] of Object.entries(OPENAI_MODEL_FAMILY_MAP)) {
    if (modified.match(regex)) {
      return `azure-${family}` as AzureOpenAIModelFamily;
    }
  }
  return defaultFamily;
}

export function assertIsKnownModelFamily(
  modelFamily: string
): asserts modelFamily is ModelFamily {
  if (!MODEL_FAMILIES.includes(modelFamily as ModelFamily)) {
    throw new Error(`Unknown model family: ${modelFamily}`);
  }
}

export function getModelFamilyForRequest(req: Request): ModelFamily {
  if (req.modelFamily) return req.modelFamily;
  // There is a single request queue, but it is partitioned by model family.
  // Model families are typically separated on cost/rate limit boundaries so
  // they should be treated as separate queues.
  const model = req.body.model ?? "gpt-3.5-turbo";
  let modelFamily: ModelFamily;

  // Weird special case for AWS/GCP/Azure because they serve models with
  // different API formats, so the outbound API alone is not sufficient to
  // determine the partition.
  if (req.service === "aws") {
    modelFamily = getAwsBedrockModelFamily(model);
  } else if (req.service === "gcp") {
    modelFamily = getGcpModelFamily(model);
  } else if (req.service === "azure") {
    modelFamily = getAzureOpenAIModelFamily(model);
  } else if (req.service === "qwen") {
    modelFamily = "qwen";
  } else {
    switch (req.outboundApi) {
      case "anthropic-chat":
      case "anthropic-text":
        modelFamily = getClaudeModelFamily(model);
        break;
      case "openai":
      case "openai-text":
      case "openai-image":
        if (req.service === "deepseek") {
          modelFamily = "deepseek";
        } else if (req.service === "xai") {
          modelFamily = "xai";
        } else if (req.service === "moonshot") {
          modelFamily = "moonshot";
        } else {
          modelFamily = getOpenAIModelFamily(model);
        }
        break;
      case "google-ai":
        modelFamily = getGoogleAIModelFamily(model);
        break;
      case "mistral-ai":
      case "mistral-text":
        modelFamily = getMistralAIModelFamily(model);
        break;
      case "openai-responses":
        modelFamily = getOpenAIModelFamily(model);
        break;
      default:
        assertNever(req.outboundApi);
    }
  }

  return (req.modelFamily = modelFamily);
}

function assertNever(x: never): never {
  throw new Error(`Called assertNever with argument ${x}.`);
}