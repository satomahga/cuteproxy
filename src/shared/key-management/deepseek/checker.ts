import { DeepseekKey } from "./provider";
import { logger } from "../../../logger";
import { assertNever } from "../../utils";

const CHECK_TIMEOUT = 10000;
const SERVER_ERROR_RETRY_DELAY = 5000; // 5 seconds
const MAX_SERVER_ERROR_RETRIES = 2;
const CONNECTION_ERROR_RETRY_DELAY = 10000; // 10 seconds
const MAX_CONNECTION_ERROR_RETRIES = 2; // 3 total attempts (initial + 2 retries)

// Track server error counts for each key
const serverErrorCounts: Record<string, number> = {};
// Track connection error counts for each key
const connectionErrorCounts: Record<string, number> = {};

export class DeepseekKeyChecker {
  private log = logger.child({ module: "key-checker", service: "deepseek" });

  constructor(private readonly update: (hash: string, key: Partial<DeepseekKey>) => void) {}

  public async checkKey(key: DeepseekKey): Promise<void> {
    try {
      const result = await this.validateKey(key);
      
      // If we get here, reset any connection error counters since the request succeeded
      if (connectionErrorCounts[key.hash]) {
        delete connectionErrorCounts[key.hash];
      }
      
      if (result === "server_error") {
        // Increment server error count for this key
        const currentCount = (serverErrorCounts[key.hash] || 0) + 1;
        serverErrorCounts[key.hash] = currentCount;
        
        if (currentCount <= MAX_SERVER_ERROR_RETRIES) {
          // Schedule a retry after delay
          this.log.info(
            { hash: key.hash, retryCount: currentCount },
            `Server error detected, scheduling retry ${currentCount} of ${MAX_SERVER_ERROR_RETRIES} in ${SERVER_ERROR_RETRY_DELAY/1000} seconds`
          );
          
          setTimeout(() => {
            this.log.info({ hash: key.hash }, "Retrying key check after server error");
            this.checkKey(key);
          }, SERVER_ERROR_RETRY_DELAY);
          
          // Just mark as checked for now, but don't disable
          this.update(key.hash, {
            lastChecked: Date.now(),
          });
          
          return;
        } else {
          // Max retries reached, handle as invalid
          this.log.warn(
            { hash: key.hash, retries: currentCount },
            "Key failed server error checks multiple times, marking as invalid"
          );
          
          // Reset the counter since we're handling it now
          delete serverErrorCounts[key.hash];
          
          // Mark as invalid
          this.handleCheckResult(key, "invalid");
          return;
        }
      } else {
        // If we get a non-server-error result, reset the server error count
        if (serverErrorCounts[key.hash]) {
          delete serverErrorCounts[key.hash];
        }
        
        // Handle the result normally
        this.handleCheckResult(key, result);
      }
    } catch (error) {
      // Increment connection error count for this key
      const currentCount = (connectionErrorCounts[key.hash] || 0) + 1;
      connectionErrorCounts[key.hash] = currentCount;
      
      if (currentCount <= MAX_CONNECTION_ERROR_RETRIES) {
        // Schedule a retry after delay
        this.log.warn(
          { error, hash: key.hash, retryCount: currentCount },
          `Failed to check key status, scheduling retry ${currentCount} of ${MAX_CONNECTION_ERROR_RETRIES} in ${CONNECTION_ERROR_RETRY_DELAY/1000} seconds`
        );
        
        setTimeout(() => {
          this.log.info({ hash: key.hash }, "Retrying key check after connection error");
          this.checkKey(key);
        }, CONNECTION_ERROR_RETRY_DELAY);
        
        // Just mark as checked for now, don't change status
        this.update(key.hash, {
          lastChecked: Date.now(),
        });
      } else {
        // Max retries reached, log final warning
        this.log.warn(
          { error, hash: key.hash, retries: currentCount },
          "Key failed connection checks multiple times, marking as invalid"
        );
        
        // Reset the counter since we're handling it now
        delete connectionErrorCounts[key.hash];
        
        // Mark as invalid after exhausting retries
        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true, // Assuming connection failures after retries mean the key is invalid
          lastChecked: Date.now(),
        });
      }
    }
  }

  private async validateKey(key: DeepseekKey): Promise<"valid" | "invalid" | "quota" | "server_error"> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT);

    try {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.key}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 0,
        }),
        signal: controller.signal,
      });

      const rateLimit = {
        limit: parseInt(response.headers.get("x-ratelimit-limit") || "200"),
        remaining: parseInt(response.headers.get("x-ratelimit-remaining") || "199"),
      };

      switch (response.status) {
        case 400:
          this.log.debug(
            { key: key.hash, rateLimit },
            "Key check successful, updating rate limit info"
          );
          return "valid";
        case 401:
          this.log.warn({ hash: key.hash }, "Key is invalid (authentication failed)");
          return "invalid";
        case 402:
          this.log.warn({ hash: key.hash }, "Key has insufficient balance");
          return "quota";
        case 429:
          this.log.warn({ key: key.hash }, "Key is rate limited");
          return "valid";
        case 500:
          this.log.warn({ hash: key.hash }, "Server error when checking key");
          return "server_error";
        case 503:
          this.log.warn({ hash: key.hash }, "Server overloaded when checking key");
          return "server_error";
        default:
          this.log.warn(
            { status: response.status, hash: key.hash },
            "Unexpected status code while checking key"
          );
          return "valid";
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private handleCheckResult(
    key: DeepseekKey,
    result: "valid" | "invalid" | "quota" | "server_error"
  ): void {
    switch (result) {
      case "valid":
        this.update(key.hash, {
          isDisabled: false,
          lastChecked: Date.now(),
        });
        break;
      case "invalid":
        this.log.warn({ hash: key.hash }, "Key is invalid");
        this.update(key.hash, {
          isDisabled: true,
          isRevoked: true,
          lastChecked: Date.now(),
        });
        break;
      case "quota":
        this.log.warn({ hash: key.hash }, "Key has exceeded its quota");
        this.update(key.hash, {
          isDisabled: true,
          isOverQuota: true,
          lastChecked: Date.now(),
        });
        break;
      case "server_error":
        // This case is now handled in the checkKey method with retries
        this.log.warn({ hash: key.hash }, "Server error when checking key");
        this.update(key.hash, {
          lastChecked: Date.now(),
        });
        break;
      default:
        assertNever(result);
    }
  }
}