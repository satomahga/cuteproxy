import { Key } from "..";
import { QwenModelFamily } from "../../models";

// Define the QwenKey interface here to avoid circular dependency
export interface QwenKey extends Key {
  readonly service: "qwen";
  readonly modelFamilies: QwenModelFamily[];
  isOverQuota: boolean;
  // "qwenTokens" is removed, tokenUsage from base Key interface will be used.
}
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;
const API_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

export class QwenKeyChecker {
  private log = logger.child({ module: "key-checker", service: "qwen" });

  constructor(private readonly update: (hash: string, key: Partial<QwenKey>) => void) {
    this.log.info("QwenKeyChecker initialized");
  }

  public async checkKey(key: QwenKey): Promise<void> {
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

  private async validateKey(key: QwenKey): Promise<"valid" | "invalid" | "quota"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      this.log.warn({ hash: key.hash }, "Key validation timed out after " + CHECK_TIMEOUT + "ms");
    }, CHECK_TIMEOUT);

    try {
      // Simple test request to check if the key is valid
      const headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key.key}`
      };

      const body = {
        model: "qwen-turbo",
        max_tokens: 5,
        temperature: 0.2,
        messages: [
          {
            role: "user",
            content: "Hello"
          }
        ]
      };

      const response = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Check response status
      if (response.status === 200) {
        return "valid";
      } else if (response.status === 401) {
        // Invalid API key
        return "invalid";
      } else if (response.status === 429) {
        // Rate limit or quota exceeded
        const responseBody = await response.json();
        const errorMsg = responseBody?.error?.message || "";
        
        // Check if it's a quota issue or just rate limiting
        if (errorMsg.includes("quota") || errorMsg.includes("billing")) {
          return "quota";
        }
        
        // Otherwise it's just rate limited, still valid
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
    key: QwenKey,
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
