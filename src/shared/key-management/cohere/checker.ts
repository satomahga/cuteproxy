import { CohereKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;
const API_URL = "https://api.cohere.com/v1/check-api-key";

export class CohereKeyChecker {
  private log = logger.child({ module: "key-checker", service: "cohere" });

  constructor(private readonly update: (hash: string, key: Partial<CohereKey>) => void) {
    this.log.info("CohereKeyChecker initialized");
  }

  public async checkKey(key: CohereKey): Promise<void> {
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

  private async validateKey(key: CohereKey): Promise<"valid" | "invalid" | "quota"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      this.log.warn({ hash: key.hash }, "Key validation timed out after " + CHECK_TIMEOUT + "ms");
    }, CHECK_TIMEOUT);

    try {
      // Check API key endpoint to verify key validity as per the provided example
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key.key}`,
        "Cohere-Version": "2022-12-06"
      };

      const response = await fetch(API_URL, {
        method: "POST",
        headers,
        signal: controller.signal,
      });

      // According to the provided example, we should check for valid:true in the response
      const data = await response.json();

      if (response.status === 200) {
        if (data.valid === true) {
          return "valid";
        } else {
          return "invalid";
        }
      } else if (response.status === 429) {
        return "quota";
      } else {
        this.log.warn(
          { status: response.status, hash: key.hash },
          "Unexpected status code while testing key validity"
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
    key: CohereKey,
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
