import { AxiosError } from "axios";
import { KeyCheckerBase } from "../key-checker-base";
import type { OpenAIKey, OpenAIKeyProvider, OpenAIKeyUpdate } from "./provider";
import { OpenAIModelFamily, getOpenAIModelFamily } from "../../models";
import { getAxiosInstance } from "../../network";

const axios = getAxiosInstance();

const MIN_CHECK_INTERVAL = 3 * 1000; // 3 seconds
const KEY_CHECK_PERIOD = 5 * 60 * 60 * 1000; // 5 hours
const POST_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const POST_IMAGE_GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const GET_MODELS_URL = "https://api.openai.com/v1/models";
const GET_ORGANIZATIONS_URL = "https://api.openai.com/v1/me";

type GetModelsResponse = {
  data: [{ id: string }];
};

type GetOrganizationsResponse = {
  orgs: {data: [{ id: string; is_default: boolean }]};
};

type OpenAIError = {
  error: { type: string; code: string; param: unknown; message: string };
};

type CloneFn = typeof OpenAIKeyProvider.prototype.clone;
type UpdateFn = typeof OpenAIKeyProvider.prototype.update;

export class OpenAIKeyChecker extends KeyCheckerBase<OpenAIKey> {
  private readonly cloneKey: CloneFn;

  constructor(keys: OpenAIKey[], cloneFn: CloneFn, updateKey: UpdateFn) {
    super(keys, {
      service: "openai",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      recurringChecksEnabled: false,
      updateKey,
    });
    this.cloneKey = cloneFn;
  }

  protected async testKeyOrFail(key: OpenAIKey) {
    // We only need to check for provisioned models on the initial check.
    const isInitialCheck = !key.lastChecked;
    if (isInitialCheck) {
      const [provisionedModels, livenessTest] = await Promise.all([
        this.getProvisionedModels(key),
        this.testLiveness(key),
        this.maybeCreateOrganizationClones(key),
      ]);
      const updates: OpenAIKeyUpdate = {
        modelFamilies: provisionedModels,
        isTrial: livenessTest.rateLimit <= 250,
      };
      
      // Test organization verification status for all keys
      // This is needed for GPT-5, o1, o3, and gpt-image-1 streaming restrictions
        try {
          const isVerifiedOrg = await this.testVerifiedOrg(key);
        // Always set the organizationVerified field for all keys
        updates.organizationVerified = isVerifiedOrg;
        
        // Only remove gpt-image from unverified orgs if they have it
        if (!isVerifiedOrg && provisionedModels.includes("gpt-image")) {
            const updatedFamilies = provisionedModels.filter(family => family !== "gpt-image");
            updates.modelFamilies = updatedFamilies;
            this.log.warn({ key: key.hash }, "Key's organization is not verified. Removing gpt-image-1 from available models.");
        }
        
        if (isVerifiedOrg) {
          this.log.info({ key: key.hash }, "Verified organization status for key. Can use streaming for GPT-5, o1, o3, and gpt-image-1.");
        } else {
          this.log.warn({ key: key.hash }, "Key's organization is not verified. Streaming restricted for GPT-5, o1, o3, and gpt-image-1.");
        }
      } catch (error) {
        // If test fails, assume no access to be safe
        updates.organizationVerified = false;
        if (provisionedModels.includes("gpt-image")) {
          const updatedFamilies = provisionedModels.filter(family => family !== "gpt-image");
          updates.modelFamilies = updatedFamilies;
        }
        this.log.error({ key: key.hash, error }, "Error testing organization verification status. Assuming not verified for safety.");
      }
      
      this.updateKey(key.hash, updates);
    } else {
      // No updates needed as models and trial status generally don't change.
      const [_livenessTest] = await Promise.all([this.testLiveness(key)]);
      this.updateKey(key.hash, {});
    }
    this.log.info(
      {
        key: key.hash,
        models: key.modelFamilies,
        trial: key.isTrial,
        snapshots: key.modelIds,
      },
      "Checked key."
    );
  }

  private async getProvisionedModels(
    key: OpenAIKey
  ): Promise<OpenAIModelFamily[]> {
    const opts = { headers: OpenAIKeyChecker.getHeaders(key) };
    const { data } = await axios.get<GetModelsResponse>(GET_MODELS_URL, opts);
    const ids = new Set<string>();
    const families = new Set<OpenAIModelFamily>();
    data.data.forEach(({ id }) => {
      ids.add(id);
      families.add(getOpenAIModelFamily(id, "turbo"));
    });

    // disable dall-e for trial keys due to very low per-day quota that tends to
    // render the key unusable.
    if (key.isTrial) {
      families.delete("dall-e");
    }

    this.updateKey(key.hash, {
      modelIds: Array.from(ids),
      modelFamilies: Array.from(families),
    });

    return key.modelFamilies;
  }

  private async maybeCreateOrganizationClones(key: OpenAIKey) {
    if (key.organizationId) return; // already cloned
    try {
      const opts = { headers: { Authorization: `Bearer ${key.key}` } };
      const { data } = await axios.get<GetOrganizationsResponse>(
        GET_ORGANIZATIONS_URL,
        opts
      );
      const organizations = data.orgs.data;
      const defaultOrg = organizations.find(({ is_default }) => is_default);
      this.updateKey(key.hash, { organizationId: defaultOrg?.id });
      if (organizations.length <= 1) return;

      this.log.info(
        { parent: key.hash, organizations: organizations.map((org) => org.id) },
        "Key is associated with multiple organizations; cloning key for each organization."
      );

      const ids = organizations
        .filter(({ is_default }) => !is_default)
        .map(({ id }) => id);
      this.cloneKey(key.hash, ids);
    } catch (error) {
      // Some keys do not have permission to list organizations, which is the
      // typical cause of this error.
      let info: string | Record<string, any>;
      const response = error.response;
      const expectedErrorCodes = ["invalid_api_key", "no_organization"];
      if (expectedErrorCodes.includes(response?.data?.error?.code)) {
        return;
      } else if (response) {
        info = { status: response.status, data: response.data };
      } else {
        info = error.message;
      }

      this.log.warn(
        { parent: key.hash, error: info },
        "Failed to fetch organizations for key."
      );
      return;
    }

    // It's possible that the keychecker may be stopped if all non-cloned keys
    // happened to be unusable, in which case this clnoe will never be checked
    // unless we restart the keychecker.
    if (!this.timeout) {
      this.log.warn(
        { parent: key.hash },
        "Restarting key checker to check cloned keys."
      );
      this.scheduleNextCheck();
    }
  }

  protected handleAxiosError(key: OpenAIKey, error: AxiosError) {
    if (error.response && OpenAIKeyChecker.errorIsOpenAIError(error)) {
      const { status, data } = error.response;
      if (status === 401) {
        this.log.warn(
          { key: key.hash, error: data },
          "Key is invalid or revoked. Disabling key."
        );
        this.updateKey(key.hash, {
          isDisabled: true,
          isRevoked: true,
          modelFamilies: ["turbo"],
        });
      } else if (status === 429) {
        switch (data.error.type) {
          case "insufficient_quota":
          case "billing_not_active":
          case "access_terminated":
            const isRevoked = data.error.type === "access_terminated";
            const isOverQuota = !isRevoked;
            const modelFamilies: OpenAIModelFamily[] = isRevoked
              ? ["turbo"]
              : key.modelFamilies;
            this.log.warn(
              { key: key.hash, rateLimitType: data.error.type, error: data },
              "Key returned a non-transient 429 error. Disabling key."
            );
            this.updateKey(key.hash, {
              isDisabled: true,
              isRevoked,
              isOverQuota,
              modelFamilies,
            });
            break;
          case "requests":
            // If we hit the text completion rate limit on a trial key, it is
            // likely being used by many proxies. We will disable the key since
            // it's just going to be constantly rate limited.
            const isTrial =
              Number(error.response.headers["x-ratelimit-limit-requests"]) <=
              250;

            if (isTrial) {
              this.log.warn(
                { key: key.hash, error: data },
                "Trial key is rate limited on text completion endpoint. This indicates the key is being used by several proxies at once and is not likely to be usable. Disabling key."
              );
              this.updateKey(key.hash, {
                isTrial,
                isDisabled: true,
                isOverQuota: true,
                modelFamilies: ["turbo"],
                lastChecked: Date.now(),
              });
            } else {
              this.log.warn(
                { key: key.hash, error: data },
                "Non-trial key is rate limited on text completion endpoint. This is unusual and may indicate a bug. Assuming key is operational."
              );
              this.updateKey(key.hash, { lastChecked: Date.now() });
            }
            break;
          case "tokens":
            // Hitting a token rate limit, even on a trial key, actually implies
            // that the key is valid and can generate completions, so we will
            // treat this as effectively a successful `testLiveness` call.
            this.log.info(
              { key: key.hash },
              "Key is currently `tokens` rate limited; assuming it is operational."
            );
            this.updateKey(key.hash, { lastChecked: Date.now() });
            break;
          default:
            this.log.error(
              { key: key.hash, rateLimitType: data.error.type, error: data },
              "Encountered unexpected rate limit error class while checking key. This may indicate a change in the API; please report this."
            );
            // We don't know what this error means, so we just let the key
            // through and maybe it will fail when someone tries to use it.
            this.updateKey(key.hash, { lastChecked: Date.now() });
        }
      } else {
        this.log.error(
          { key: key.hash, status, error: data },
          "Encountered unexpected error status while checking key. This may indicate a change in the API; please report this."
        );
        this.updateKey(key.hash, { lastChecked: Date.now() });
      }
      return;
    }
    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in a minute."
    );
    const oneMinute = 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneMinute);
    this.updateKey(key.hash, { lastChecked: next });
  }

  /**
   * Tests whether the key is valid and has quota remaining. The request we send
   * is actually not valid, but keys which are revoked or out of quota will fail
   * with a 401 or 429 error instead of the expected 400 Bad Request error.
   * This lets us avoid test keys without spending any quota.
   *
   * We use the rate limit header to determine whether it's a trial key.
   */
  private async testLiveness(key: OpenAIKey): Promise<{ rateLimit: number }> {
    // What the hell this is doing:

    // OpenAI enforces separate rate limits for chat and text completions. Trial
    // keys have extremely low rate limits of 200 per day per API type. In order
    // to avoid wasting more valuable chat quota, we send an (invalid) chat
    // request to Babbage (a text completion model). Even though our request is
    // to the chat endpoint, we get text rate limit headers back because the
    // requested model determines the rate limit used, not the endpoint.

    // Once we have headers, we can determine:
    // 1. Is the key revoked? (401, OAI doesn't even validate the request)
    // 2. Is the key out of quota? (400, OAI will still validate the request)
    // 3. Is the key a trial key? (400, x-ratelimit-limit-requests: 200)

    // This might still cause issues if too many proxies are running a train on
    // the same trial key and even the text completion quota is exhausted, but
    // it should work better than the alternative.

    const payload = {
      model: "babbage-002",
      max_tokens: -1,
      messages: [{ role: "user", content: "" }],
    };
    const { headers, data } = await axios.post<OpenAIError>(
      POST_CHAT_COMPLETIONS_URL,
      payload,
      {
        headers: OpenAIKeyChecker.getHeaders(key),
        validateStatus: (status) => status === 404,
      }
    );
    const rateLimitHeader = headers["x-ratelimit-limit-requests"];
    const rateLimit = parseInt(rateLimitHeader) || 3500; // trials have 200

    // invalid_request_error is the expected error
    if (data.error.type !== "invalid_request_error") {
      this.log.warn(
        { key: key.hash, error: data },
        "Unexpected 404 error class while checking key; assuming key is valid, but this may indicate a change in the API."
      );
    }
    return { rateLimit };
  }

  static errorIsOpenAIError(
    error: AxiosError
  ): error is AxiosError<OpenAIError> {
    const data = error.response?.data as any;
    return data?.error?.type;
  }

  /**
   * Tests whether the key's organization is verified by attempting to stream from the gpt-5-mini model.
   * Only verified organizations can stream from GPT-5 models, so this is a reliable test for both
   * GPT-5 streaming and gpt-image-1 access (which also requires verified organization status).
   * Returns true if the organization is verified.
   */
  public async testVerifiedOrg(key: OpenAIKey): Promise<boolean> {
    this.log.info({ key: key.hash }, "Testing organization verification status via gpt-5-mini streaming");
    
    try {
      const payload = {
        model: "gpt-5",
        messages: [{ role: "user", content: "Hi" }],
        max_completion_tokens: 1,
        stream: true
      };
      
      // Make a minimal streaming request to check organization verification
      const response = await axios.post(
        POST_CHAT_COMPLETIONS_URL,
        payload,
        {
          headers: OpenAIKeyChecker.getHeaders(key),
          validateStatus: (status) => true, // Accept any status code to inspect errors
          timeout: 30000, // 30 second timeout
          signal: AbortSignal.timeout(30000)
        }
      );
      
      // If we get a 200 response, the organization is verified
      if (response.status === 200) {
        this.log.info(
          { key: key.hash, status: response.status },
          `Organization is verified. Streaming gpt-5-mini request succeeded with status code ${response.status}`
        );
        return true;
      }
      
      // Check for specific error responses that indicate unverified organization
      const data = response.data as any;
      const errorMessage = data?.error?.message || '';
      
      // Explicitly check for organization verification errors
      if (errorMessage.includes("organization must be verified")) {
        this.log.warn(
          { key: key.hash, status: response.status, error: errorMessage },
          "Organization is not verified: verification required for streaming gpt-5-mini"
        );
        return false;
      }
      
      // If we get a 400 error but it's not about verification, the organization might be verified
      // but there's another issue with the request
      if (response.status === 400 && !errorMessage.includes("organization must be verified")) {
        // Check if the error is specifically about the 'stream' parameter
        if (errorMessage.includes("stream") && errorMessage.includes("unsupported_value")) {
          this.log.warn(
            { key: key.hash, status: response.status, error: errorMessage },
            "Organization is not verified: cannot stream with gpt-5-mini"
          );
          return false;
        }
        
        // If it's some other validation error, the organization might be verified
        this.log.info(
          { key: key.hash, status: response.status, error: errorMessage },
          "Got 400 error but not related to organization verification. Assuming organization is verified."
        );
        return true;
      }
      
      // For other status codes, log the issue but assume unverified
      this.log.warn(
        { key: key.hash, status: response.status, error: errorMessage },
        "Unexpected response when testing organization verification, assuming not verified"
      );
      return false;
      
    } catch (error) {
      // Handle network errors or request failures
      if (error instanceof AxiosError && error.response) {
        const status = error.response.status;
        const data = error.response.data as any;
        const errorMessage = data?.error?.message || 'Unknown error';
        
        // Check for specific error messages related to organization verification
        if (errorMessage.includes("organization must be verified")) {
          this.log.warn(
            { key: key.hash, status, error: errorMessage },
            "Organization is not verified based on error message"
          );
          return false;
        }
        
        // If we get a 400 error but it's not about verification, the organization might be verified
        if (status === 400 && !errorMessage.includes("organization must be verified")) {
          // Check if the error is specifically about the 'stream' parameter
          if (errorMessage.includes("stream") && errorMessage.includes("unsupported_value")) {
            this.log.warn(
              { key: key.hash, status, error: errorMessage },
              "Organization is not verified: cannot stream with gpt-5-mini"
            );
            return false;
          }
          
          // If it's some other validation error, the organization might be verified
          this.log.info(
            { key: key.hash, status, error: errorMessage },
            "Got 400 error but not related to organization verification. Assuming organization is verified."
          );
          return true;
        }
      }
      
      // For all other errors, assume unverified for safety
      this.log.error(
        { key: key.hash, error: error instanceof Error ? error.message : String(error) },
        "Error testing organization verification status. Assuming not verified for safety."
      );
      return false;
    }
  }

  static getHeaders(key: OpenAIKey) {
    const useOrg = !key.key.includes("svcacct");
    return {
      Authorization: `Bearer ${key.key}`,
      ...(useOrg &&
        key.organizationId && { "OpenAI-Organization": key.organizationId }),
    };
  }
}
