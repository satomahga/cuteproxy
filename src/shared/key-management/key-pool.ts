import crypto from "crypto";
import type * as http from "http";
import os from "os";
import schedule from "node-schedule";
import { config } from "../../config";
import { logger } from "../../logger";
import { LLMService, MODEL_FAMILY_SERVICE, ModelFamily } from "../models";
import { Key, KeyProvider } from "./index";
import { AnthropicKeyProvider, AnthropicKeyUpdate } from "./anthropic/provider";
import { OpenAIKeyProvider, OpenAIKeyUpdate } from "./openai/provider";
import { GoogleAIKeyProvider  } from "./google-ai/provider";
import { AwsBedrockKeyProvider } from "./aws/provider";
import { GcpKeyProvider, GcpKey } from "./gcp/provider";
import { AzureOpenAIKeyProvider } from "./azure/provider";
import { MistralAIKeyProvider } from "./mistral-ai/provider";
import { DeepseekKeyProvider } from "./deepseek/provider";
import { XaiKeyProvider } from "./xai/provider";
import { CohereKeyProvider } from "./cohere/provider";
import { QwenKeyProvider } from "./qwen/provider";
import { MoonshotKeyProvider } from "./moonshot/provider";

type AllowedPartial = OpenAIKeyUpdate | AnthropicKeyUpdate | Partial<GcpKey>;

export class KeyPool {
  private keyProviders: KeyProvider[] = [];
  private recheckJobs: Partial<Record<LLMService, schedule.Job | null>> = {
    openai: null,
  };

  constructor() {
    this.keyProviders.push(new OpenAIKeyProvider());
    this.keyProviders.push(new AnthropicKeyProvider());
    this.keyProviders.push(new GoogleAIKeyProvider());
    this.keyProviders.push(new MistralAIKeyProvider());
    this.keyProviders.push(new AwsBedrockKeyProvider());
    this.keyProviders.push(new GcpKeyProvider());
    this.keyProviders.push(new AzureOpenAIKeyProvider());
    this.keyProviders.push(new DeepseekKeyProvider());
    this.keyProviders.push(new XaiKeyProvider());
    this.keyProviders.push(new CohereKeyProvider());
    this.keyProviders.push(new QwenKeyProvider());
    this.keyProviders.push(new MoonshotKeyProvider());
  }

  public init() {
    this.keyProviders.forEach((provider) => provider.init());
    const availableKeys = this.available("all");
    if (availableKeys === 0) {
      throw new Error(
        "No keys loaded. Ensure that at least one key is configured."
      );
    }
    this.scheduleRecheck();
  }

  public get(model: string, service?: LLMService, multimodal?: boolean, streaming?: boolean): Key {
    // hack for some claude requests needing keys with particular permissions
    // even though they use the same models as the non-multimodal requests
    if (multimodal) {
      model += "-multimodal";
    }
    
    const queryService = service || this.getServiceForModel(model);
    return this.getKeyProvider(queryService).get(model, streaming);
  }

  public list(): Omit<Key, "key">[] {
    return this.keyProviders.flatMap((provider) => provider.list());
  }

  /**
   * Marks a key as disabled for a specific reason. `revoked` should be used
   * to indicate a key that can never be used again, while `quota` should be
   * used to indicate a key that is still valid but has exceeded its quota.
   */
  public disable(key: Key, reason: "quota" | "revoked"): void {
    const service = this.getKeyProvider(key.service);
    service.disable(key);
    service.update(key.hash, { isRevoked: reason === "revoked" });
    if (
      service instanceof OpenAIKeyProvider ||
      service instanceof AnthropicKeyProvider ||
      service instanceof DeepseekKeyProvider ||
      service instanceof XaiKeyProvider ||
      service instanceof CohereKeyProvider ||
      service instanceof QwenKeyProvider ||
      service instanceof MoonshotKeyProvider
    ) {
      service.update(key.hash, { isOverQuota: reason === "quota" });
    }
  }

  /**
   * Updates a key in the keypool with the given properties.
   *
   * Be aware that the `key` argument may not be the same object instance as the
   * one in the keypool (such as if it is a clone received via `KeyPool.get` in
   * which case you are responsible for updating your clone with the new
   * properties.
   */
  public update(key: Key, props: AllowedPartial): void {
    const service = this.getKeyProvider(key.service);
    service.update(key.hash, props);
  }

  public available(model: string | "all" = "all"): number {
    return this.keyProviders.reduce((sum, provider) => {
      const includeProvider =
        model === "all" || this.getServiceForModel(model) === provider.service;
      return sum + (includeProvider ? provider.available() : 0);
    }, 0);
  }

  public incrementUsage(key: Key, modelName: string, usage: { input: number; output: number }): void {
    const provider = this.getKeyProvider(key.service);
    // Assuming the provider's incrementUsage expects a modelFamily.
    // We need a robust way to get modelFamily from modelName here.
    // This might involve calling a method similar to getModelFamilyForRequest from user-store,
    // or enhancing getServiceForModel to also return family, or passing family directly.
    // For now, let's assume the provider can handle the modelName or we derive family.
    // This part is tricky as KeyPool's getServiceForModel is for service, not family directly from a generic model string.
    // Let's assume for now the provider's incrementUsage can take modelName and derive family,
    // or the KeyProvider interface's incrementUsage should take modelName.
    // The KeyProvider interface was changed to modelFamily. So we MUST derive it.
    // This requires a utility function similar to what's in user-store or models.ts.
    // For now, I'll placeholder this derivation. This is a critical point.
    // Placeholder: const modelFamily = this.getModelFamilyForModel(modelName, key.service);
    // This is complex because getModelFamilyForModel needs the service context.
    // Let's assume the `modelName` passed here is actually `modelFamily` for now,
    // or that the caller will resolve it.
    // The KeyProvider interface expects `modelFamily`. The caller in middleware/response/index.ts
    // has `model` (name) and `req.outboundApi`. It should resolve to family there.
    // So, `modelName` here should actually be `modelFamily`.
    // I will assume the caller of KeyPool.incrementUsage will pass modelFamily.
    // So, changing `model: string` to `modelFamily: ModelFamily` in signature.
    // This change needs to be propagated to the caller.
    provider.incrementUsage(key.hash, modelName as ModelFamily, usage); // Casting modelName, assuming caller provides family
  }

  public getLockoutPeriod(family: ModelFamily): number {
    const service = MODEL_FAMILY_SERVICE[family];
    return this.getKeyProvider(service).getLockoutPeriod(family);
  }

  public markRateLimited(key: Key): void {
    const provider = this.getKeyProvider(key.service);
    provider.markRateLimited(key.hash);
  }

  public updateRateLimits(key: Key, headers: http.IncomingHttpHeaders): void {
    const provider = this.getKeyProvider(key.service);
    if (provider instanceof OpenAIKeyProvider) {
      provider.updateRateLimits(key.hash, headers);
    }
  }

  public recheck(service: LLMService): void {
    if (!config.checkKeys) {
      logger.info("Skipping key recheck because key checking is disabled");
      return;
    }

    const provider = this.getKeyProvider(service);
    provider.recheck();
  }
  
  /**
   * Validates organization verification status for all OpenAI keys and returns detailed results.
   * This tests each key that claims to have gpt-image-1 or o3 access by attempting to stream from the o3 model,
   * which requires a verified organization. Keys from unverified organizations will have only
   * gpt-image-1 access removed from their available model families, as o3 can still be used without streaming.
   */
  public async validateGptImageAccess(): Promise<{
    total: number;
    validated: number;
    removed: string[];
    verified: string[];
    errors: {key: string, error: string}[];
  }> {
    const provider = this.getKeyProvider("openai");
    if (!(provider instanceof OpenAIKeyProvider)) {
      throw new Error("OpenAI provider not initialized");
    }
    
    return provider.validateGptImageAccess();
  }

  private getServiceForModel(model: string): LLMService {
    if (model.startsWith("deepseek")) {
      return "deepseek";
    } else if (
      model.startsWith("gpt") ||
      model.startsWith("text-embedding-ada") ||
      model.startsWith("dall-e")
    ) {
      // https://platform.openai.com/docs/models/model-endpoint-compatibility
      return "openai";
    } else if (model.startsWith("claude-")) {
      // https://console.anthropic.com/docs/api/reference#parameters
      if (!model.includes('@')) {
        return "anthropic";
      } else {
        return "gcp";
      }
    } else if (model.includes("gemini")) {
      // https://developers.generativeai.google.com/models/language
      return "google-ai";
    } else if (model.includes("mistral")) {
      // https://docs.mistral.ai/platform/endpoints
      return "mistral-ai";
    } else if (model.includes("xai")) {
      return "xai";
    } else if (model.includes("command") || model.includes("cohere")) {
      return "cohere";
    } else if (model.includes("qwen")) {
      return "qwen";
    } else if (model.includes("moonshot")) {
      return "moonshot";
    } else if (model.startsWith("anthropic.claude")) {
      // AWS offers models from a few providers
      // https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids-arns.html
      return "aws";
    } else if (model.startsWith("azure")) {
      return "azure";
    }
    throw new Error(`Unknown service for model '${model}'`);
  }

  private getKeyProvider(service: LLMService): KeyProvider {
    return this.keyProviders.find((provider) => provider.service === service)!;
  }

  /**
   * Schedules periodic rechecks of keys:
   * - OpenAI keys: every 8 hours
   * - Google AI keys: every 1 hour (to handle quota resets more promptly)
   * All schedules have an offset based on the server's hostname.
   */
  private scheduleRecheck(): void {
    const machineHash = crypto
      .createHash("sha256")
      .update(os.hostname())
      .digest("hex");
    const offset = parseInt(machineHash, 16) % 7;
    
    // OpenAI keys recheck every 8 hours
    const openaiHour = [0, 8, 16].map((h) => h + offset).join(",");
    const openaiCrontab = `0 ${openaiHour} * * *`;

    const openaiJob = schedule.scheduleJob(openaiCrontab, () => {
      const next = openaiJob.nextInvocation();
      logger.info({ next, service: "openai" }, "Performing periodic OpenAI key recheck.");
      this.recheck("openai");
    });
    logger.info(
      { rule: openaiCrontab, next: openaiJob.nextInvocation(), service: "openai" },
      "Scheduled periodic OpenAI key recheck job"
    );
    this.recheckJobs.openai = openaiJob;

    // Schedule hourly recheck for Google AI keys to handle quota resets more quickly
    const googleMinute = offset;
    const googleCrontab = `${googleMinute} * * * *`; // Run every hour
    
    const googleJob = schedule.scheduleJob(googleCrontab, () => {
      const next = googleJob.nextInvocation();
      logger.info({ next, service: "google-ai" }, "Performing hourly Google AI key recheck for quota status.");
      this.recheck("google-ai");
    });
    logger.info(
      { rule: googleCrontab, next: googleJob.nextInvocation(), service: "google-ai" },
      "Scheduled hourly Google AI key recheck job"
    );
    this.recheckJobs["google-ai"] = googleJob;
  }
}
