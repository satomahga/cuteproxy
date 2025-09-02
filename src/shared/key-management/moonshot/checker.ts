import { MoonshotKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;
const API_URL = "https://api.moonshot.cn/v1/users/me/balance";

export class MoonshotKeyChecker {
  private log = logger.child({ module: "key-checker", service: "moonshot" });

  constructor(private readonly update: (hash: string, key: Partial<MoonshotKey>) => void) {
    this.log.info("MoonshotKeyChecker initialized");
  }

  public async checkKey(key: MoonshotKey): Promise<void> {
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

  private async validateKey(key: MoonshotKey): Promise<"valid" | "invalid" | "quota"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      this.log.warn({ hash: key.hash }, "Key validation timed out after " + CHECK_TIMEOUT + "ms");
    }, CHECK_TIMEOUT);

    try {
      // Check balance endpoint to verify key validity
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key.key}`
      };

      const response = await fetch(API_URL, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (response.status === 200) {
        const data = await response.json();
        // Check if response has the expected Moonshot API structure
        if (data && data.status === true && data.code === 0 && data.data) {
          const balance = data.data.available_balance;
          // Check if balance is too low (consider it quota exceeded if balance is 0 or negative)
          if (typeof balance === 'number' && balance <= 0) {
            return "quota";
          }
          return "valid";
        } else {
          this.log.warn(
            { response: data, hash: key.hash },
            "Unexpected response format from Moonshot API"
          );
          return "invalid";
        }
      } else if (response.status === 401) {
        // Unauthorized - invalid key
        return "invalid";
      } else if (response.status === 429) {
        // Rate limit - but key is valid
        return "valid";
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
    key: MoonshotKey,
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
