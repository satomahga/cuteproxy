import { XaiKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;

export class XaiKeyChecker {
  private log = logger.child({ module: "key-checker", service: "xai" });

  constructor(private readonly update: (hash: string, key: Partial<XaiKey>) => void) {
    this.log.info("XaiKeyChecker initialized");
  }

  public async checkKey(key: XaiKey): Promise<void> {
    this.log.info({ hash: key.hash }, "Starting key validation check");
    try {
      const result = await this.validateKey(key);
      this.handleCheckResult(key, result);
    } catch (error) {
      if (error instanceof Error) {
        this.log.warn(
          { error: error.message, stack: error.stack, hash: key.hash },
          "Failed to check key status"
        );
      } else {
        this.log.warn(
          { error, hash: key.hash },
          "Failed to check key status with unknown error"
        );
      }
    }
  }

  private async validateKey(key: XaiKey): Promise<"valid" | "invalid" | "quota"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      this.log.warn({ hash: key.hash }, "Key validation timed out after " + CHECK_TIMEOUT + "ms");
    }, CHECK_TIMEOUT);

    try {
      // First check API key endpoint to verify key validity
      const apiResponse = await fetch("https://api.x.ai/v1/api-key", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key.key}`,
        },
        signal: controller.signal,
      });

      if (apiResponse.status !== 200) {
        // Key is invalid or has some other issue
        return "invalid";
      }
      
      const apiData = await apiResponse.json();
      const isBlocked = apiData.team_blocked || apiData.api_key_blocked || apiData.api_key_disabled;
      
      if (isBlocked) {
        return "invalid";
      }
      
      // If the key passed the first check, test a minimal API call to verify quota
      const testResponse = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.key}`,
        },
        body: JSON.stringify({
          messages: [],
          model: "grok-3-mini-latest",
          frequency_penalty: -3.0,
        }),
        signal: controller.signal,
      });

      // If we get 400 or 200, the key is valid (400 might be parameter error but key is valid)
      if (testResponse.status === 400 || testResponse.status === 200) {
        return "valid";
      } else if (testResponse.status === 429) {
        return "quota";
      } else if (testResponse.status === 403) {
        this.log.warn(
          { status: testResponse.status, hash: key.hash },
          "Forbidden (403) response, key is invalid"
        );
        return "invalid";
      } else {
        this.log.warn(
          { status: testResponse.status, hash: key.hash },
          "Unexpected status code while testing key usage"
        );
        return "invalid";
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.log.warn({ hash: key.hash }, "Key validation aborted");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleCheckResult(
    key: XaiKey,
    result: "valid" | "invalid" | "quota"
  ): void {
    switch (result) {
      case "valid":
        this.log.info({ hash: key.hash }, "Key is valid and enabled");
        this.update(key.hash, {
          isDisabled: false,
          lastChecked: Date.now(),
        });
        break;
      case "invalid":
        this.log.warn({ hash: key.hash }, "Key is invalid, marking as revoked");
        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true,
          lastChecked: Date.now(),
        });
        break;
      case "quota":
        this.log.warn({ hash: key.hash }, "Key has exceeded its quota, disabling");
        this.update(key.hash, {
          isDisabled: true,
          isOverQuota: true,
          lastChecked: Date.now(),
        });
        break;
      default:
        assertNever(result);
    }
  }
}
