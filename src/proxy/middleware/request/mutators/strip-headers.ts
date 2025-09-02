import { ProxyReqMutator } from "../index";

/**
 * Removes origin and referer headers before sending the request to the API for
 * privacy reasons.
 */
export const stripHeaders: ProxyReqMutator = (manager) => {
  manager.removeHeader("origin");
  manager.removeHeader("referer");

  // Some APIs refuse requests coming from browsers to discourage embedding
  // API keys in client-side code, so we must remove all CORS/fetch headers.
  Object.keys(manager.request.headers).forEach((key) => {
    if (key.startsWith("sec-")) {
      manager.removeHeader(key);
    }
  });

  manager.removeHeader("tailscale-user-login");
  manager.removeHeader("tailscale-user-name");
  manager.removeHeader("tailscale-headers-info");
  manager.removeHeader("tailscale-user-profile-pic");
  manager.removeHeader("cf-connecting-ip");
  manager.removeHeader("cf-ray");
  manager.removeHeader("cf-visitor");
  manager.removeHeader("cf-warp-tag-id");
  manager.removeHeader("forwarded");
  manager.removeHeader("true-client-ip");
  manager.removeHeader("x-forwarded-for");
  manager.removeHeader("x-forwarded-host");
  manager.removeHeader("x-forwarded-proto");
  manager.removeHeader("x-real-ip");
};
