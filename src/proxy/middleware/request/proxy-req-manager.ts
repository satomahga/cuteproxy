import { Request } from "express";
import { Key } from "../../../shared/key-management";
import { assertNever } from "../../../shared/utils";

/**
 * Represents a change to the request that will be reverted if the request
 * fails.
 */
interface ProxyReqMutation {
  target: "header" | "path" | "body" | "api-key" | "signed-request";
  key?: string;
  originalValue: any | undefined;
}

/**
 * Manages a request's headers, body, and path, allowing them to be modified
 * before the request is proxied and automatically reverted if the request
 * needs to be retried.
 */
export class ProxyReqManager {
  private req: Request;
  private mutations: ProxyReqMutation[] = [];

  /**
   * A read-only proxy of the request object. Avoid changing any properties
   * here as they will persist across retries.
   */
  public readonly request: Readonly<Request>;

  constructor(req: Request) {
    this.req = req;

    this.request = new Proxy(req, {
      get: (target, prop) => {
        if (typeof prop === "string") return target[prop as keyof Request];
        return undefined;
      },
    });
  }

  setHeader(name: string, newValue: string): void {
    const originalValue = this.req.get(name);
    this.mutations.push({ target: "header", key: name, originalValue });
    this.req.headers[name.toLowerCase()] = newValue;
  }

  removeHeader(name: string): void {
    const originalValue = this.req.get(name);
    this.mutations.push({ target: "header", key: name, originalValue });
    delete this.req.headers[name.toLowerCase()];
  }

  setBody(newBody: any): void {
    const originalValue = this.req.body;
    this.mutations.push({ target: "body", key: "body", originalValue });
    this.req.body = newBody;
  }

  setKey(newKey: Key): void {
    const originalValue = this.req.key;
    this.mutations.push({ target: "api-key", key: "key", originalValue });
    this.req.key = newKey;
  }

  setPath(newPath: string): void {
    const originalValue = this.req.path;
    this.mutations.push({ target: "path", key: "path", originalValue });
    this.req.url = newPath;
  }

  setSignedRequest(newSignedRequest: typeof this.req.signedRequest): void {
    const originalValue = this.req.signedRequest;
    this.mutations.push({ target: "signed-request", key: "signedRequest", originalValue });
    this.req.signedRequest = newSignedRequest;
  }

  hasChanged(): boolean {
    return this.mutations.length > 0;
  }

  revert(): void {
    for (const mutation of this.mutations.reverse()) {
      switch (mutation.target) {
        case "header":
          if (mutation.originalValue === undefined) {
            delete this.req.headers[mutation.key!.toLowerCase()];
            continue;
          } else {
            this.req.headers[mutation.key!.toLowerCase()] =
              mutation.originalValue;
          }
          break;
        case "path":
          this.req.url = mutation.originalValue;
          break;
        case "body":
          this.req.body = mutation.originalValue;
          break;
        case "api-key":
          // We don't reset the key here because it's not a property of the
          // inbound request, so we'd only ever be reverting it to null.
          break;
        case "signed-request":
          this.req.signedRequest = mutation.originalValue;
          break;
        default:
          assertNever(mutation.target);
      }
    }
    this.mutations = [];
  }
}
