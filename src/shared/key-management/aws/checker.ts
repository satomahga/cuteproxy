import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { AxiosError, AxiosHeaders, AxiosRequestConfig } from "axios";
import { URL } from "url";
import { config } from "../../../config";
import { getAwsBedrockModelFamily } from "../../models";
import { getAxiosInstance } from "../../network";
import { KeyCheckerBase } from "../key-checker-base";
import type { AwsBedrockKey, AwsBedrockKeyProvider } from "./provider";

const axios = getAxiosInstance();

type ParentModelId = string;
type AliasModelId = string;
type ModuleAliasTuple = [ParentModelId, ...AliasModelId[]];

const KNOWN_MODEL_IDS: ModuleAliasTuple[] = [
  ["anthropic.claude-instant-v1"],
  ["anthropic.claude-v2", "anthropic.claude-v2:1"],
  ["anthropic.claude-3-sonnet-20240229-v1:0"],
  ["anthropic.claude-3-haiku-20240307-v1:0"],
  ["anthropic.claude-3-5-haiku-20241022-v1:0"],
  ["anthropic.claude-3-opus-20240229-v1:0"],
  ["anthropic.claude-3-5-sonnet-20240620-v1:0"],
  ["anthropic.claude-3-5-sonnet-20241022-v2:0"],
  ["anthropic.claude-3-7-sonnet-20250219-v1:0"],
  ["anthropic.claude-sonnet-4-20250514-v1:0"],
  ["anthropic.claude-opus-4-20250514-v1:0"],
  ["anthropic.claude-opus-4-1-20250805-v1:0"],
  ["mistral.mistral-7b-instruct-v0:2"],
  ["mistral.mixtral-8x7b-instruct-v0:1"],
  ["mistral.mistral-large-2402-v1:0"],
  ["mistral.mistral-large-2407-v1:0"],
  ["mistral.mistral-small-2402-v1:0"], // Seems to return 400
];

const KEY_CHECK_BATCH_SIZE = 2; // AWS checker needs to do lots of concurrent requests so should lower the batch size
const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 90 * 60 * 1000; // 90 minutes
const AMZ_HOST =
  process.env.AMZ_HOST || "bedrock-runtime.%REGION%.amazonaws.com";
const GET_CALLER_IDENTITY_URL = `https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15`;
const GET_INVOCATION_LOGGING_CONFIG_URL = (region: string) =>
  `https://bedrock.${region}.amazonaws.com/logging/modelinvocations`;
const GET_LIST_INFERENCE_PROFILES_URL = (region: string) =>
  `https://bedrock.${region}.amazonaws.com/inference-profiles?maxResults=1000`;
const POST_INVOKE_MODEL_URL = (region: string, model: string) =>
  `https://${AMZ_HOST.replace("%REGION%", region)}/model/${model}/invoke`;
const TEST_MESSAGES = [
  { role: "user", content: "Hi!" },
  { role: "assistant", content: "Hello!" },
];

type AwsError = { error: {} };

type GetInferenceProfilesResponse = {
  inferenceProfileSummaries: {
    inferenceProfileId: string;
    inferenceProfileName: string;
    inferenceProfileArn: string;
    description?: string;
    createdAt?: string;
    updatedAt?: string;
    status: "ACTIVE" | unknown;
    type: "SYSTEM_DEFINED" | unknown;
    models: {
      modelArn?: string;
    }[];
  }[];
};

type GetLoggingConfigResponse = {
  loggingConfig: null | {
    cloudWatchConfig: null | unknown;
    s3Config: null | unknown;
    embeddingDataDeliveryEnabled: boolean;
    imageDataDeliveryEnabled: boolean;
    textDataDeliveryEnabled: boolean;
  };
};

type UpdateFn = typeof AwsBedrockKeyProvider.prototype.update;

export class AwsKeyChecker extends KeyCheckerBase<AwsBedrockKey> {
  constructor(keys: AwsBedrockKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "aws",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      keyCheckBatchSize: KEY_CHECK_BATCH_SIZE,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: AwsBedrockKey) {
    const isInitialCheck = !key.lastChecked;

    // Keys with logging enabled will get rejected in the provider
    await this.checkLoggingConfiguration(key);
    if (isInitialCheck) {
      try {
        await this.checkInferenceProfiles(key);
      } catch (e) {
        const asError = e as AxiosError<AwsError>;
        const data = asError.response?.data;
        this.log.warn(
          { key: key.hash, error: e.message, data },
          "Cannot list inference profiles.\n\
Principal may be missing `AmazonBedrockFullAccess`, or has no policy allowing action `bedrock:ListInferenceProfiles` against resource `arn:aws:bedrock:*:*:inference-profile/*`.\n\
Requests will be made without inference profiles using on-demand quotas, which may be subject to more restrictive rate limits.\n\
See https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference-prereq.html."
        );
      }
    }

    // Perform checks for all parent model IDs
    // TODO: use allsettled
    const results = await Promise.all(
      KNOWN_MODEL_IDS.filter(([model]) =>
        // Skip checks for models that are disabled anyway
        config.allowedModelFamilies.includes(getAwsBedrockModelFamily(model))
      ).map(async ([model, ...aliases]) => ({
        models: [model, ...aliases],
        success: await this.invokeModel(model, key),
      }))
    );

    // Filter out models that are disabled
    const modelIds = results
      .filter(({ success }) => success)
      .flatMap(({ models }) => models);

    if (modelIds.length === 0) {
      this.log.warn(
        { key: key.hash },
        "Key does not have access to any models; disabling."
      );
      return this.updateKey(key.hash, { isDisabled: true });
    }

    this.updateKey(key.hash, {
      modelIds,
      modelFamilies: Array.from(
        new Set(modelIds.map(getAwsBedrockModelFamily))
      ),
    });

    this.log.info(
      {
        key: key.hash,
        logged: key.awsLoggingStatus,
        families: key.modelFamilies,
        models: key.modelIds,
      },
      "Checked key."
    );
  }

  protected handleAxiosError(key: AwsBedrockKey, error: AxiosError) {
    if (error.response && AwsKeyChecker.errorIsAwsError(error)) {
      const errorHeader = error.response.headers["x-amzn-errortype"] as string;
      const errorType = errorHeader.split(":")[0];
      switch (errorType) {
        case "AccessDeniedException":
          // Indicates that the principal's attached policy does not allow them
          // to perform the requested action.
          // How we handle this depends on whether the action was one that we
          // must be able to perform in order to use the key.
          const path = new URL(error.config?.url!).pathname;
          const data = error.response.data;
          this.log.warn(
            { key: key.hash, type: errorType, path, data },
            "Key can't perform a required action; disabling."
          );
          return this.updateKey(key.hash, { isDisabled: true });
        case "UnrecognizedClientException":
          // This is a 403 error that indicates the key is revoked.
          this.log.warn(
            { key: key.hash, errorType, error: error.response.data },
            "Key is revoked; disabling."
          );
          return this.updateKey(key.hash, {
            isDisabled: true,
            isRevoked: true,
          });
        case "ThrottlingException":
          // This is a 429 error that indicates the key is rate-limited, but
          // not necessarily disabled. Retry in 10 seconds.
          this.log.warn(
            { key: key.hash, errorType, error: error.response.data },
            "Key is rate limited. Rechecking in 30 seconds."
          );
          const next = Date.now() - (KEY_CHECK_PERIOD - 30 * 1000);
          return this.updateKey(key.hash, { lastChecked: next });
        case "ValidationException":
        default:
          // This indicates some issue that we did not account for, possibly
          // a new ValidationException type. This likely means our key checker
          // needs to be updated so we'll just let the key through and let it
          // fail when someone tries to use it if the error is fatal.
          this.log.error(
            { key: key.hash, errorType, error: error.response.data },
            "Encountered unexpected error while checking key. This may indicate a change in the API; please report this."
          );
          return this.updateKey(key.hash, { lastChecked: Date.now() });
      }
    }
    const { response } = error;
    const { headers, status, data } = response ?? {};
    this.log.error(
      { key: key.hash, status, headers, data, error: error.message },
      "Network error while checking key; trying this key again in a minute."
    );
    const oneMinute = 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneMinute);
    this.updateKey(key.hash, { lastChecked: next });
  }

  /**
   * Attempt to invoke the given model with the given key.  Returns true if the
   * key has access to the model, false if it does not. Throws an error if the
   * key is disabled.
   */
  private async invokeModel(
    model: string,
    key: AwsBedrockKey
  ): Promise<boolean> {
    if (model.includes("claude")) {
      // If inference profiles are available, try testing model with them.
      // If they are not available or the invocation fails with the inference
      // profile, fall back to regular model ID.
      const { region } = AwsKeyChecker.getCredentialsFromKey(key);
      const continent = region.split("-")[0];
      const profile = key.inferenceProfileIds.find(
        (id) => `${continent}.${model}` === id
      );

      if (profile) {
        this.log.debug(
          { key: key.hash, model, profile },
          "Testing model via inference profile."
        );
        let result: boolean;
        try {
          result = await this.testClaudeModel(key, profile);
        } catch (e) {
          this.log.error(
            { key: key.hash, model, profile, error: e.message },
            "InvokeModel via inference profile returned an error; trying model ID directly."
          );
          result = false;
        }

        // If the profile worked, we'll return success. Caller will add the
        // model (not the profile) to the list of enabled models, but the
        // profile will be used when the key is used for inference.
        if (result) return true;
      }
      this.log.debug({ key: key.hash, model }, "Testing model via model ID.");
      return this.testClaudeModel(key, model);
    } else if (model.includes("mistral")) {
      return this.testMistralModel(key, model);
    }
    throw new Error("AwsKeyChecker#invokeModel: no implementation for model");
  }

  private async testClaudeModel(
    key: AwsBedrockKey,
    model: string
  ): Promise<boolean> {
    const creds = AwsKeyChecker.getCredentialsFromKey(key);
    // This is not a valid invocation payload, but a 400 response indicates that
    // the principal at least has permission to invoke the model.
    // A 403 response indicates that the model is not accessible -- if none of
    // the models are accessible, the key is effectively disabled.
    const payload = {
      max_tokens: -1,
      messages: TEST_MESSAGES,
      anthropic_version: "bedrock-2023-05-31",
    };
    const config: AxiosRequestConfig = {
      method: "POST",
      url: POST_INVOKE_MODEL_URL(creds.region, model),
      data: payload,
      validateStatus: (status) => [400, 403, 404, 429, 503].includes(status),
    };
    config.headers = new AxiosHeaders({
      "content-type": "application/json",
      accept: "*/*",
    });
    await AwsKeyChecker.signRequestForAws(config, key);
    const response = await axios.request(config);
    const { data, status, headers } = response;
    const errorType = (headers["x-amzn-errortype"] as string).split(":")[0];
    const errorMessage = data?.message;

    // 503 ServiceUnavailableException errors are usually due to temporary
    // outages in the AWS infrastructure. However, because a 503 response also
    // indicates that the key can invoke the model, we can treat this as a
    // successful response.
    if (status === 503 && errorType.match(/ServiceUnavailableException/i)) {
      this.log.warn(
        { key: key.hash, model, errorType, data, status, headers },
        "Model is accessible, but may be temporarily unavailable."
      );
      return true;
    }

    // 429 ThrottlingException can suggest the model is available but the key
    // is being rate limited. I think if a key does not have access to the
    // model, it cannot receive a 429 response, so this should be a success.
    if (status === 429) {
      if (errorType.match(/ThrottlingException/i)) {
        this.log.debug(
          { key: key.hash, model, errorType, data, status, headers },
          "Model is available but key is rate limited."
        );
        return true;
      } else {
        throw new AxiosError(
          `InvokeModel returned 429 of type ${errorType}`,
          `AWS_INVOKE_MODEL_RATE_LIMITED`,
          response.config,
          response.request,
          response
        );
      }
    }

    // This message indicates the key is valid but this particular model is not
    // accessible. Other 403s may indicate the key is not usable.
    if (
      status === 403 &&
      errorMessage?.match(/access to the model with the specified model ID/)
    ) {
      this.log.debug(
        { key: key.hash, model, errorType, data, status, headers },
        "Model is not available (principal does not have access)."
      );
      return false;
    }

    // ResourceNotFound typically indicates that the tested model cannot be used
    // on the configured region for this set of credentials.
    if (status === 404) {
      this.log.debug(
        { region: creds.region, model, key: key.hash },
        "Model is not available (not supported in this AWS region)."
      );
      return false;
    }

    // We're looking for a specific error type and message here
    // "ValidationException"
    const correctErrorType = errorType === "ValidationException";
    const correctErrorMessage = errorMessage?.match(/max_tokens/);
    if (!correctErrorType || !correctErrorMessage) {
      this.log.debug(
        { key: key.hash, model, errorType, data, status },
        "Model is not available (request rejected)."
      );
      return false;
    }

    this.log.debug(
      { key: key.hash, model, errorType, data, status },
      "Model is available."
    );
    return true;
  }

  private async testMistralModel(
    key: AwsBedrockKey,
    model: string
  ): Promise<boolean> {
    const creds = AwsKeyChecker.getCredentialsFromKey(key);

    const payload = {
      max_tokens: -1,
      prompt: "<s>[INST] What is your favourite condiment? [/INST]</s>",
    };
    const config: AxiosRequestConfig = {
      method: "POST",
      url: POST_INVOKE_MODEL_URL(creds.region, model),
      data: payload,
      validateStatus: (status) => [400, 403, 404].includes(status),
      headers: {
        "content-type": "application/json",
        accept: "*/*",
      },
    };
    await AwsKeyChecker.signRequestForAws(config, key);
    const response = await axios.request(config);
    const { data, status, headers } = response;
    const errorType = (headers["x-amzn-errortype"] as string).split(":")[0];
    const errorMessage = data?.message;

    if (status === 403 || status === 404) {
      this.log.debug(
        { key: key.hash, model, errorType, data, status },
        "Model is not available (no access or unsupported region)."
      );
      return false;
    }

    const isBadRequest = status === 400;
    const isValidationError = errorMessage?.match(/validation error/i);
    if (isBadRequest && !isValidationError) {
      this.log.debug(
        { key: key.hash, model, errorType, data, status, headers },
        "Model is not available (request rejected)."
      );
      return false;
    }

    this.log.debug(
      { key: key.hash, model, errorType, data, status },
      "Model is available."
    );
    return true;
  }

  private async checkInferenceProfiles(key: AwsBedrockKey) {
    const creds = AwsKeyChecker.getCredentialsFromKey(key);
    const req: AxiosRequestConfig = {
      method: "GET",
      url: GET_LIST_INFERENCE_PROFILES_URL(creds.region),
      headers: { accept: "application/json" },
    };
    await AwsKeyChecker.signRequestForAws(req, key);
    const { data } = await axios.request<GetInferenceProfilesResponse>(req);
    const { inferenceProfileSummaries } = data;
    const profileIds = inferenceProfileSummaries.map(
      (p) => p.inferenceProfileId
    );
    this.log.debug(
      { key: key.hash, profileIds, region: creds.region },
      "Inference profiles found."
    );
    this.updateKey(key.hash, { inferenceProfileIds: profileIds });
  }

  private async checkLoggingConfiguration(key: AwsBedrockKey) {
    if (config.allowAwsLogging) {
      // Don't check logging status if we're allowing it to reduce API calls.
      this.updateKey(key.hash, { awsLoggingStatus: "unknown" });
      return true;
    }

    const creds = AwsKeyChecker.getCredentialsFromKey(key);
    const req: AxiosRequestConfig = {
      method: "GET",
      url: GET_INVOCATION_LOGGING_CONFIG_URL(creds.region),
      headers: { accept: "application/json" },
      validateStatus: () => true,
    };
    await AwsKeyChecker.signRequestForAws(req, key);
    const { data, status, headers } =
      await axios.request<GetLoggingConfigResponse>(req);

    let result: AwsBedrockKey["awsLoggingStatus"] = "unknown";

    if (status === 200) {
      const { loggingConfig } = data;
      const loggingEnabled = !!loggingConfig?.textDataDeliveryEnabled;
      this.log.debug(
        { key: key.hash, loggingConfig, loggingEnabled },
        "AWS model invocation logging test complete."
      );
      result = loggingEnabled ? "enabled" : "disabled";
    } else {
      const errorType = (headers["x-amzn-errortype"] as string).split(":")[0];
      this.log.debug(
        { key: key.hash, errorType, data, status },
        "Can't determine AWS model invocation logging status."
      );
    }

    this.updateKey(key.hash, { awsLoggingStatus: result });
    return !!result;
  }

  static errorIsAwsError(error: AxiosError): error is AxiosError<AwsError> {
    const headers = error.response?.headers;
    if (!headers) return false;
    return !!headers["x-amzn-errortype"];
  }

  /** Given an Axios request, sign it with the given key. */
  static async signRequestForAws(
    axiosRequest: AxiosRequestConfig,
    key: AwsBedrockKey,
    awsService = "bedrock"
  ) {
    const creds = AwsKeyChecker.getCredentialsFromKey(key);
    const { accessKeyId, secretAccessKey, region } = creds;
    const { method, url: axUrl, headers: axHeaders, data } = axiosRequest;
    const url = new URL(axUrl!);

    let plainHeaders = {};
    if (axHeaders instanceof AxiosHeaders) {
      plainHeaders = axHeaders.toJSON();
    } else if (typeof axHeaders === "object") {
      plainHeaders = axHeaders;
    }

    const request = new HttpRequest({
      method,
      protocol: "https:",
      hostname: url.hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { Host: url.hostname, ...plainHeaders },
    });

    if (data) {
      request.body = JSON.stringify(data);
    }

    const signer = new SignatureV4({
      sha256: Sha256,
      credentials: { accessKeyId, secretAccessKey },
      region,
      service: awsService,
    });
    const signedRequest = await signer.sign(request);
    axiosRequest.headers = signedRequest.headers;
  }

  static getCredentialsFromKey(key: AwsBedrockKey) {
    const [accessKeyId, secretAccessKey, region] = key.key.split(":");
    if (!accessKeyId || !secretAccessKey || !region) {
      throw new Error("Invalid AWS Bedrock key");
    }
    return { accessKeyId, secretAccessKey, region };
  }
}
