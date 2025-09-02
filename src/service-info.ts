import { config, listConfig } from "./config";
import {
  AnthropicKey,
  AwsBedrockKey,
  DeepseekKey,
  GcpKey,
  keyPool,
  OpenAIKey,
  XaiKey,
  CohereKey,
  QwenKey,
  MoonshotKey,
} from "./shared/key-management";
import {
  AnthropicModelFamily,
  assertIsKnownModelFamily,
  AwsBedrockModelFamily,
  GcpModelFamily,
  AzureOpenAIModelFamily,
  GoogleAIModelFamily,
  LLM_SERVICES,
  LLMService,
  MistralAIModelFamily,
  MODEL_FAMILY_SERVICE,
  ModelFamily,
  OpenAIModelFamily,
  DeepseekModelFamily,
  XaiModelFamily,
  CohereModelFamily,
  QwenModelFamily,
  MoonshotModelFamily,
} from "./shared/models";
import { getCostSuffix, getTokenCostUsd, prettyTokens } from "./shared/stats";
import { getUniqueIps } from "./proxy/rate-limit";
import { assertNever } from "./shared/utils";
import { getEstimatedWaitTime, getQueueLength } from "./proxy/queue";

const CACHE_TTL = 2000;

// Define the preferred order for model families in the service info display
// This ensures logical grouping (GPT-4 models together, then GPT-4.1, then GPT-5, etc.)
const MODEL_FAMILY_ORDER: ModelFamily[] = [
  // OpenAI models in logical order
  "turbo",
  "gpt4",
  "gpt4-32k", 
  "gpt4-turbo",
  "gpt4o",
  "gpt41",
  "gpt41-mini",
  "gpt41-nano",
  "gpt45",
  "gpt5",
  "gpt5-mini",
  "gpt5-nano",
  "gpt5-chat-latest",
  "o1",
  "o1-mini",
  "o1-pro",
  "o3",
  "o3-mini",
  "o3-pro",
  "o4-mini",
  "codex-mini",
  "dall-e",
  "gpt-image",
  // Azure OpenAI models (same order as OpenAI)
  "azure-turbo",
  "azure-gpt4",
  "azure-gpt4-32k",
  "azure-gpt4-turbo",
  "azure-gpt4o",
  "azure-gpt41",
  "azure-gpt41-mini",
  "azure-gpt41-nano",
  "azure-gpt45",
  "azure-gpt5",
  "azure-gpt5-mini",
  "azure-gpt5-nano",
  "azure-gpt5-chat-latest",
  "azure-o1",
  "azure-o1-mini",
  "azure-o1-pro",
  "azure-o3",
  "azure-o3-mini",
  "azure-o3-pro",
  "azure-o4-mini",
  "azure-codex-mini",
  "azure-dall-e",
  "azure-gpt-image",
  // Anthropic models
  "claude",
  "claude-opus",
  // Google AI models
  "gemini-flash",
  "gemini-pro",
  "gemini-ultra",
  // Mistral AI models
  "mistral-tiny",
  "mistral-small",
  "mistral-medium",
  "mistral-large",
  // AWS Bedrock models
  "aws-claude",
  "aws-claude-opus",
  "aws-mistral-tiny",
  "aws-mistral-small",
  "aws-mistral-medium",
  "aws-mistral-large",
  // GCP models
  "gcp-claude",
  "gcp-claude-opus",
  // Other services
  "deepseek",
  "xai",
  "cohere",
  "qwen",
  "moonshot"
];

type KeyPoolKey = ReturnType<typeof keyPool.list>[0];
const keyIsOpenAIKey = (k: KeyPoolKey): k is OpenAIKey =>
  k.service === "openai";
const keyIsAnthropicKey = (k: KeyPoolKey): k is AnthropicKey =>
  k.service === "anthropic";
const keyIsAwsKey = (k: KeyPoolKey): k is AwsBedrockKey => k.service === "aws";
const keyIsGcpKey = (k: KeyPoolKey): k is GcpKey => k.service === "gcp";
const keyIsDeepseekKey = (k: KeyPoolKey): k is DeepseekKey =>
  k.service === "deepseek";
const keyIsXaiKey = (k: KeyPoolKey): k is XaiKey =>
  k.service === "xai";
const keyIsCohereKey = (k: KeyPoolKey): k is CohereKey =>
  k.service === "cohere";
const keyIsQwenKey = (k: KeyPoolKey): k is QwenKey =>
  k.service === "qwen";
const keyIsMoonshotKey = (k: KeyPoolKey): k is MoonshotKey =>
  k.service === "moonshot";

/** Stats aggregated across all keys for a given service. */
type ServiceAggregate = "keys" | "uncheckedKeys" | "orgs";
/** Stats aggregated across all keys for a given model family. */
type ModelAggregates = {
  active: number;
  trial?: number;
  revoked?: number;
  overQuota?: number;
  pozzed?: number;
  awsLogged?: number;
  // needed to disambugiate aws-claude family's variants
  awsClaude2?: number;
  awsSonnet3?: number;
  awsSonnet3_5?: number;
  awsSonnet3_7?: number;
  awsSonnet4?: number;
  awsOpus3?: number;
  awsOpus4?: number;
  awsHaiku: number;
  gcpSonnet?: number;
  gcpSonnet35?: number;
  gcpHaiku?: number;
  queued: number;
  inputTokens: number; // Changed from tokens
  outputTokens: number; // Added
  legacyTokens?: number; // Added for migrated totals
};
/** All possible combinations of model family and aggregate type. */
type ModelAggregateKey = `${ModelFamily}__${keyof ModelAggregates}`;

type AllStats = {
  proompts: number;
  inputTokens: number; // Changed from tokens
  outputTokens: number; // Added
  legacyTokens?: number; // Added
  tokenCost: number;
} & { [modelFamily in ModelFamily]?: ModelAggregates } & {
  [service in LLMService as `${service}__${ServiceAggregate}`]?: number;
};

type BaseFamilyInfo = {
  usage?: string;
  activeKeys: number;
  revokedKeys?: number;
  proomptersInQueue?: number;
  estimatedQueueTime?: string;
};
type OpenAIInfo = BaseFamilyInfo & {
  trialKeys?: number;
  overQuotaKeys?: number;
};
type AnthropicInfo = BaseFamilyInfo & {
  trialKeys?: number;
  prefilledKeys?: number;
  overQuotaKeys?: number;
};
type AwsInfo = BaseFamilyInfo & {
  privacy?: string;
  enabledVariants?: string;
};
type GcpInfo = BaseFamilyInfo & {
  enabledVariants?: string;
};

// prettier-ignore
export type ServiceInfo = {
  uptime: number;
  endpoints: {
    openai?: string;
    deepseek?: string;
    xai?: string;
    anthropic?: string;
    "google-ai"?: string;
    "mistral-ai"?: string;
    "aws"?: string;
    gcp?: string;
    azure?: string;
    "openai-image"?: string;
    "azure-image"?: string;
  };
  proompts?: number;
  tookens?: string;
  proomptersNow?: number;
  status?: string;
  config: ReturnType<typeof listConfig>;
  build: string;
} & { [f in OpenAIModelFamily]?: OpenAIInfo }
  & { [f in AnthropicModelFamily]?: AnthropicInfo; }
  & { [f in AwsBedrockModelFamily]?: AwsInfo }
  & { [f in GcpModelFamily]?: GcpInfo }
  & { [f in AzureOpenAIModelFamily]?: BaseFamilyInfo; }
  & { [f in GoogleAIModelFamily]?: BaseFamilyInfo & { overQuotaKeys?: number } }
  & { [f in MistralAIModelFamily]?: BaseFamilyInfo }
  & { [f in DeepseekModelFamily]?: BaseFamilyInfo }
  & { [f in XaiModelFamily]?: BaseFamilyInfo }
  & { [f in CohereModelFamily]?: BaseFamilyInfo }
  & { [f in QwenModelFamily]?: BaseFamilyInfo }
  & { [f in MoonshotModelFamily]?: BaseFamilyInfo };

// https://stackoverflow.com/a/66661477
// type DeepKeyOf<T> = (
//   [T] extends [never]
//     ? ""
//     : T extends object
//     ? {
//         [K in Exclude<keyof T, symbol>]: `${K}${DotPrefix<DeepKeyOf<T[K]>>}`;
//       }[Exclude<keyof T, symbol>]
//     : ""
// ) extends infer D
//   ? Extract<D, string>
//   : never;
// type DotPrefix<T extends string> = T extends "" ? "" : `.${T}`;
// type ServiceInfoPath = `{${DeepKeyOf<ServiceInfo>}}`;

const SERVICE_ENDPOINTS: { [s in LLMService]: Record<string, string> } = {
  openai: {
    openai: `%BASE%/openai`,
    "openai-image": `%BASE%/openai-image`,
  },
  anthropic: {
    anthropic: `%BASE%/anthropic`,
  },
  "google-ai": {
    "google-ai": `%BASE%/google-ai`,
  },
  "mistral-ai": {
    "mistral-ai": `%BASE%/mistral-ai`,
  },
  aws: {
    "aws-claude": `%BASE%/aws/claude`,
    "aws-mistral": `%BASE%/aws/mistral`,
  },
  gcp: {
    gcp: `%BASE%/gcp/claude`,
  },
  azure: {
    azure: `%BASE%/azure/openai`,
    "azure-image": `%BASE%/azure/openai`,
  },
  deepseek: {
    deepseek: `%BASE%/deepseek`,
  },
  xai: {
    xai: `%BASE%/xai`,
  },
  cohere: {
    cohere: `%BASE%/cohere`,
  },
  qwen: {
    qwen: `%BASE%/qwen`,
  },
  moonshot: {
    moonshot: `%BASE%/moonshot`,
  },
};

const familyStats = new Map<ModelAggregateKey, number>();
const serviceStats = new Map<keyof AllStats, number>();

let cachedInfo: ServiceInfo | undefined;
let cacheTime = 0;

export function buildInfo(baseUrl: string, forAdmin = false): ServiceInfo {
  if (cacheTime + CACHE_TTL > Date.now()) return cachedInfo!;

  const keys = keyPool.list();
  const accessibleFamilies = new Set(
    keys
      .flatMap((k) => k.modelFamilies)
      .filter((f) => config.allowedModelFamilies.includes(f))
      .concat("turbo")
  );

  familyStats.clear();
  serviceStats.clear();
  keys.forEach(addKeyToAggregates);

  const endpoints = getEndpoints(baseUrl, accessibleFamilies);
  const trafficStats = getTrafficStats();
  const { serviceInfo, modelFamilyInfo } =
    getServiceModelStats(accessibleFamilies);
  const status = getStatus();

  if (config.staticServiceInfo && !forAdmin) {
    delete trafficStats.proompts;
    delete trafficStats.tookens;
    delete trafficStats.proomptersNow;
    for (const family of Object.keys(modelFamilyInfo)) {
      assertIsKnownModelFamily(family);
      delete modelFamilyInfo[family]?.proomptersInQueue;
      delete modelFamilyInfo[family]?.estimatedQueueTime;
      delete modelFamilyInfo[family]?.usage;
    }
  }

  return (cachedInfo = {
    uptime: Math.floor(process.uptime()),
    endpoints,
    ...trafficStats,
    ...serviceInfo,
    status,
    ...modelFamilyInfo,
    config: listConfig(),
    build: process.env.BUILD_INFO || "dev",
  });
}

function getStatus() {
  if (!config.checkKeys)
    return "Key checking is disabled. The data displayed are not reliable.";

  let unchecked = 0;
  for (const service of LLM_SERVICES) {
    unchecked += serviceStats.get(`${service}__uncheckedKeys`) || 0;
  }

  return unchecked ? `Checking ${unchecked} keys...` : undefined;
}

function getEndpoints(baseUrl: string, accessibleFamilies: Set<ModelFamily>) {
  const endpoints: Record<string, string> = {};
  const keys = keyPool.list();
  for (const service of LLM_SERVICES) {
    if (!keys.some((k) => k.service === service)) {
      continue;
    }

    for (const [name, url] of Object.entries(SERVICE_ENDPOINTS[service])) {
      endpoints[name] = url.replace("%BASE%", baseUrl);
    }

    if (service === "openai" && !accessibleFamilies.has("dall-e")) {
      delete endpoints["openai-image"];
    }

    if (service === "azure" && !accessibleFamilies.has("azure-dall-e")) {
      delete endpoints["azure-image"];
    }
  }
  return endpoints;
}

type TrafficStats = Pick<ServiceInfo, "proompts" | "tookens" | "proomptersNow">;

function getTrafficStats(): TrafficStats {
  const inputTokens = serviceStats.get("inputTokens") || 0;
  const outputTokens = serviceStats.get("outputTokens") || 0;
  // const legacyTokens = serviceStats.get("legacyTokens") || 0; // Optional: include in total if desired
  const totalTokens = inputTokens + outputTokens; // + legacyTokens;
  const tokenCost = serviceStats.get("tokenCost") || 0;
  return {
    proompts: serviceStats.get("proompts") || 0,
    tookens: `${prettyTokens(totalTokens)}${getCostSuffix(tokenCost)}`, // Simplified to show aggregate and cost
    ...(config.textModelRateLimit ? { proomptersNow: getUniqueIps() } : {}),
  };
}

function getServiceModelStats(accessibleFamilies: Set<ModelFamily>) {
  const serviceInfo: {
    [s in LLMService as `${s}${"Keys" | "Orgs"}`]?: number;
  } = {};
  const modelFamilyInfo: { [f in ModelFamily]?: BaseFamilyInfo } = {};

  for (const service of LLM_SERVICES) {
    const hasKeys = serviceStats.get(`${service}__keys`) || 0;
    if (!hasKeys) continue;

    serviceInfo[`${service}Keys`] = hasKeys;

    if (service === "openai" && config.checkKeys) {
      serviceInfo.openaiOrgs = getUniqueOpenAIOrgs(keyPool.list());
    }
  }

  // Build model family info in the defined order for logical grouping
  for (const family of MODEL_FAMILY_ORDER) {
    if (accessibleFamilies.has(family)) {
      modelFamilyInfo[family] = getInfoForFamily(family);
    }
  }
  return { serviceInfo, modelFamilyInfo };
}

function getUniqueOpenAIOrgs(keys: KeyPoolKey[]) {
  const orgIds = new Set(
    keys.filter((k) => k.service === "openai").map((k: any) => k.organizationId)
  );
  return orgIds.size;
}

function increment<T extends keyof AllStats | ModelAggregateKey>(
  map: Map<T, number>,
  key: T,
  delta = 1
) {
  map.set(key, (map.get(key) || 0) + delta);
}
const addToService = increment.bind(null, serviceStats);
const addToFamily = increment.bind(null, familyStats);

function addKeyToAggregates(k: KeyPoolKey) {
  addToService("proompts", k.promptCount);
  addToService("openai__keys", k.service === "openai" ? 1 : 0);
  addToService("anthropic__keys", k.service === "anthropic" ? 1 : 0);
  addToService("google-ai__keys", k.service === "google-ai" ? 1 : 0);
  addToService("mistral-ai__keys", k.service === "mistral-ai" ? 1 : 0);
  addToService("aws__keys", k.service === "aws" ? 1 : 0);
  addToService("gcp__keys", k.service === "gcp" ? 1 : 0);
  addToService("azure__keys", k.service === "azure" ? 1 : 0);
  addToService("deepseek__keys", k.service === "deepseek" ? 1 : 0);
  addToService("xai__keys", k.service === "xai" ? 1 : 0);
  addToService("cohere__keys", k.service === "cohere" ? 1 : 0);
  addToService("qwen__keys", k.service === "qwen" ? 1 : 0);
  addToService("moonshot__keys", k.service === "moonshot" ? 1 : 0);

  let sumInputTokens = 0;
  let sumOutputTokens = 0;
  let sumLegacyTokens = 0; // Optional
  let sumCost = 0;

  const incrementGenericFamilyStats = (f: ModelFamily) => {
    const usage = k.tokenUsage?.[f];
    let familyInputTokens = 0;
    let familyOutputTokens = 0;
    let familyLegacyTokens = 0;

    if (usage) {
      familyInputTokens = usage.input || 0;
      familyOutputTokens = usage.output || 0;
      if (usage.legacy_total && familyInputTokens === 0 && familyOutputTokens === 0) {
        // This is a migrated key with no new usage, use legacy_total as input for cost
        familyLegacyTokens = usage.legacy_total;
        sumCost += getTokenCostUsd(f, usage.legacy_total, 0);
      } else {
        sumCost += getTokenCostUsd(f, familyInputTokens, familyOutputTokens);
      }
    }
    // If no k.tokenUsage[f], tokens are 0, cost is 0.

    sumInputTokens += familyInputTokens;
    sumOutputTokens += familyOutputTokens;
    sumLegacyTokens += familyLegacyTokens; // Optional

    addToFamily(`${f}__inputTokens`, familyInputTokens);
    addToFamily(`${f}__outputTokens`, familyOutputTokens);
    if (familyLegacyTokens > 0) {
      addToFamily(`${f}__legacyTokens`, familyLegacyTokens); // Optional
    }
    addToFamily(`${f}__revoked`, k.isRevoked ? 1 : 0);
    addToFamily(`${f}__active`, k.isDisabled ? 0 : 1);
  };

  switch (k.service) {
    case "openai":
      if (!keyIsOpenAIKey(k)) throw new Error("Invalid key type");
      addToService("openai__uncheckedKeys", Boolean(k.lastChecked) ? 0 : 1);
      k.modelFamilies.forEach((f) => {
        incrementGenericFamilyStats(f);
        addToFamily(`${f}__trial`, k.isTrial ? 1 : 0);
        addToFamily(`${f}__overQuota`, k.isOverQuota ? 1 : 0);
      });
      break;
    case "anthropic":
      if (!keyIsAnthropicKey(k)) throw new Error("Invalid key type");
      addToService("anthropic__uncheckedKeys", Boolean(k.lastChecked) ? 0 : 1);
      k.modelFamilies.forEach((f) => {
        incrementGenericFamilyStats(f);
        addToFamily(`${f}__trial`, k.tier === "free" ? 1 : 0);
        addToFamily(`${f}__overQuota`, k.isOverQuota ? 1 : 0);
        addToFamily(`${f}__pozzed`, k.isPozzed ? 1 : 0);
      });
      break;

    case "aws": {
      if (!keyIsAwsKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach(incrementGenericFamilyStats);
      if (!k.isDisabled) {
        // Don't add revoked keys to available AWS variants
        k.modelIds.forEach((id) => {
          if (id.includes("claude-3-sonnet")) {
            addToFamily(`aws-claude__awsSonnet3`, 1);
          // not ideal but whatever
          } else if (id.includes("claude-3-5-sonnet")) {
            addToFamily(`aws-claude__awsSonnet3_5`, 1);
          } else if (id.includes("claude-3-7-sonnet")) {
            addToFamily(`aws-claude__awsSonnet3_7`, 1);
          } else if (id.includes("claude-3-haiku")) {
            addToFamily(`aws-claude__awsHaiku`, 1);
          } else if (id.includes("sonnet-4")) {
            addToFamily(`aws-claude__awsSonnet4`, 1);
          } else if (id.includes("claude-3-opus")) {
            addToFamily(`aws-claude__awsOpus3`, 1);
            addToFamily(`aws-claude-opus__awsOpus3`, 1);
          } else if (id.includes("opus-4")) {
            addToFamily(`aws-claude__awsOpus4`, 1);
            addToFamily(`aws-claude-opus__awsOpus4`, 1);
          } else if (id.includes("claude-v2")) {
            addToFamily(`aws-claude__awsClaude2`, 1);
          }
        });
      }
      // Ignore revoked keys for aws logging stats, but include keys where the
      // logging status is unknown.
      const countAsLogged =
        k.lastChecked && !k.isDisabled && k.awsLoggingStatus === "enabled";
      addToFamily(`aws-claude__awsLogged`, countAsLogged ? 1 : 0);
      break;
    }
    case "gcp":
      if (!keyIsGcpKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach(incrementGenericFamilyStats);
      // TODO: add modelIds to GcpKey
      break;
    case "deepseek":
      if (!keyIsDeepseekKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach((f) => {
        incrementGenericFamilyStats(f);
        addToFamily(`${f}__overQuota`, k.isOverQuota ? 1 : 0);
      });
      break;
    case "xai":
      if (!keyIsXaiKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach((f) => {
        incrementGenericFamilyStats(f);
        if ('isOverQuota' in k) {
          addToFamily(`${f}__overQuota`, k.isOverQuota ? 1 : 0);
        }
      });
      break;
    case "cohere":
      if (!keyIsCohereKey(k)) throw new Error("Invalid key type");
      k.modelFamilies.forEach((f) => {
        incrementGenericFamilyStats(f);
        if ('isOverQuota' in k) {
          addToFamily(`${f}__overQuota`, k.isOverQuota ? 1 : 0);
        }
      });
      break;
    // These services don't have any additional stats to track.
    case "azure":
    case "mistral-ai":
      k.modelFamilies.forEach(incrementGenericFamilyStats);
      break;
    case "google-ai":
      // Cast to GoogleAIKey to access GoogleAI-specific properties
      const googleKey = k as unknown as { overQuotaFamilies?: string[] };
      
      // First handle general stats for all model families
      k.modelFamilies.forEach((f) => {
        incrementGenericFamilyStats(f);
      });
      
      // Create a set of model families that are over quota for this key
      let overQuotaModelFamilies = new Set<string>();
      
      // Add any model family that's listed in overQuotaFamilies
      if (googleKey.overQuotaFamilies && Array.isArray(googleKey.overQuotaFamilies)) {
        googleKey.overQuotaFamilies.forEach(family => {
          overQuotaModelFamilies.add(family);
        });
      }
      // If key is generally over quota and we don't have specific families, add all families
      else if ('isOverQuota' in k && k.isOverQuota) {
        k.modelFamilies.forEach(family => {
          overQuotaModelFamilies.add(family);
        });
      }
      
      // Now increment the over-quota counter for each affected family
      // These model families are valid and already defined in the enum
      overQuotaModelFamilies.forEach(family => {
        if (family === 'gemini-pro' || family === 'gemini-flash' || family === 'gemini-ultra') {
          addToFamily(`${family}__overQuota` as any, 1);
        }
      });
      break;
    case "qwen":
      k.modelFamilies.forEach(incrementGenericFamilyStats);
      break;
    case "moonshot":
      k.modelFamilies.forEach(incrementGenericFamilyStats);
      break;
    default:
      assertNever(k.service);
  }

  addToService("inputTokens", sumInputTokens);
  addToService("outputTokens", sumOutputTokens);
  if (sumLegacyTokens > 0) { // Optional
    addToService("legacyTokens", sumLegacyTokens);
  }
  addToService("tokenCost", sumCost);
}

function getInfoForFamily(family: ModelFamily): BaseFamilyInfo {
  const inputTokens = familyStats.get(`${family}__inputTokens`) || 0;
  const outputTokens = familyStats.get(`${family}__outputTokens`) || 0;
  const legacyTokens = familyStats.get(`${family}__legacyTokens`) || 0; // Optional

  let cost = 0;
  let displayTokens = 0;
  let usageString = "";

  if (inputTokens > 0 || outputTokens > 0) {
    cost = getTokenCostUsd(family, inputTokens, outputTokens);
    displayTokens = inputTokens + outputTokens;
    usageString = `${prettyTokens(displayTokens)} (In: ${prettyTokens(inputTokens)}, Out: ${prettyTokens(outputTokens)})${getCostSuffix(cost)}`;
  } else if (legacyTokens > 0) {
    // Only show legacy if no new input/output has been recorded for this family aggregate
    cost = getTokenCostUsd(family, legacyTokens, 0); // Cost legacy as all input
    displayTokens = legacyTokens;
    usageString = `${prettyTokens(displayTokens)} tokens (legacy total)${getCostSuffix(cost)}`;
  } else {
    usageString = `${prettyTokens(0)} tokens${getCostSuffix(0)}`;
  }
  
  let info: BaseFamilyInfo & OpenAIInfo & AnthropicInfo & AwsInfo & GcpInfo = {
    usage: usageString,
    activeKeys: familyStats.get(`${family}__active`) || 0,
    revokedKeys: familyStats.get(`${family}__revoked`) || 0,
  };

  // Add service-specific stats to the info object.
  if (config.checkKeys) {
    const service = MODEL_FAMILY_SERVICE[family];
    switch (service) {
      case "openai":
        info.overQuotaKeys = familyStats.get(`${family}__overQuota`) || 0;
        info.trialKeys = familyStats.get(`${family}__trial`) || 0;

        // Delete trial/revoked keys for non-turbo families.
        // Trials are turbo 99% of the time, and if a key is invalid we don't
        // know what models it might have had assigned to it.
        if (family !== "turbo") {
          delete info.trialKeys;
          delete info.revokedKeys;
        }
        break;
      case "anthropic":
        info.overQuotaKeys = familyStats.get(`${family}__overQuota`) || 0;
        info.trialKeys = familyStats.get(`${family}__trial`) || 0;
        info.prefilledKeys = familyStats.get(`${family}__pozzed`) || 0;
        break;
      case "aws":
        if (family === "aws-claude") {
          // Original behavior: get logged count from the same family
          const logged = familyStats.get(`${family}__awsLogged`) || 0;
          const variants = new Set<string>();
          if (familyStats.get(`${family}__awsClaude2`) || 0) variants.add("claude2");
          if (familyStats.get(`${family}__awsSonnet3`) || 0) variants.add("sonnet3");
          if (familyStats.get(`${family}__awsSonnet3_5`) || 0) variants.add("sonnet3.5");
          if (familyStats.get(`${family}__awsSonnet3_7`) || 0) variants.add("sonnet3.7");
          if (familyStats.get(`${family}__awsHaiku`) || 0) variants.add("haiku");
          if (familyStats.get(`${family}__awsSonnet4`) || 0) variants.add("sonnet4");
          
          info.enabledVariants = variants.size ? Array.from(variants).join(",") : undefined;

          if (logged > 0) {
            info.privacy = config.allowAwsLogging
              ? `AWS logging verification inactive. Prompts could be logged.`
              : `${logged} active keys are potentially logged and can't be used. Set ALLOW_AWS_LOGGING=true to override.`;
          }
        } else if (family === "aws-claude-opus") {
          // Get logging info from aws-claude family since that's where it's collected
          const awsLogged = familyStats.get(`aws-claude__awsLogged`) || 0;
          const variants = new Set<string>();
          if (familyStats.get(`${family}__awsOpus3`) || 0) variants.add("opus3");
          if (familyStats.get(`${family}__awsOpus4`) || 0) variants.add("opus4");

          info.enabledVariants = variants.size ? Array.from(variants).join(",") : undefined;

          // Show privacy warning for Opus if there are active Opus keys AND some AWS keys are logged
          if (awsLogged > 0 && info.activeKeys > 0) {
             info.privacy = config.allowAwsLogging
              ? `AWS logging verification inactive. Prompts could be logged.`
              : `Some AWS keys are potentially logged. Set ALLOW_AWS_LOGGING=true to override.`;
          }
        }
        // TODO: Consider if aws-mistral-* families need similar enabledVariant listings
        break;
      case "gcp":
        if (family === "gcp-claude") {
          // TODO: implement
          info.enabledVariants = "not implemented";
        }
        break;
      case "deepseek":
        info.overQuotaKeys = familyStats.get(`${family}__overQuota`) || 0;
        break;
      case "xai":
        info.overQuotaKeys = familyStats.get(`${family}__overQuota`) || 0;
        break;
      case "cohere":
        info.overQuotaKeys = familyStats.get(`${family}__overQuota`) || 0;
        break;
      case "google-ai":
        info.overQuotaKeys = familyStats.get(`${family}__overQuota`) || 0;
        break;
      case "qwen":
        info.overQuotaKeys = familyStats.get(`${family}__overQuota`) || 0;
        break;
      case "moonshot":
        info.overQuotaKeys = familyStats.get(`${family}__overQuota`) || 0;
        break;
    }
  }

  // Add queue stats to the info object.
  const queue = getQueueInformation(family);
  info.proomptersInQueue = queue.proomptersInQueue;
  info.estimatedQueueTime = queue.estimatedQueueTime;

  return info;
}

/** Returns queue time in seconds, or minutes + seconds if over 60 seconds. */
function getQueueInformation(partition: ModelFamily) {
  const waitMs = getEstimatedWaitTime(partition);
  const waitTime =
    waitMs < 60000
      ? `${Math.round(waitMs / 1000)}sec`
      : `${Math.round(waitMs / 60000)}min, ${Math.round(
          (waitMs % 60000) / 1000
        )}sec`;
  return {
    proomptersInQueue: getQueueLength(partition),
    estimatedQueueTime: waitMs > 2000 ? waitTime : "no wait",
  };
}
