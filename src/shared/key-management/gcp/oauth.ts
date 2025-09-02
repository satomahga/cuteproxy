import crypto from "crypto";
import type { GcpKey } from "./provider";
import { getAxiosInstance } from "../../network";
import { logger } from "../../../logger";

const axios = getAxiosInstance();
const log = logger.child({ module: "gcp-oauth" });

const authUrl = "https://www.googleapis.com/oauth2/v4/token";
const scope = "https://www.googleapis.com/auth/cloud-platform";

type GoogleAuthResponse = {
  access_token: string;
  scope: string;
  token_type: "Bearer";
  expires_in: number;
};

type GoogleAuthError = {
  error:
    | "unauthorized_client"
    | "access_denied"
    | "admin_policy_enforced"
    | "invalid_client"
    | "invalid_grant"
    | "invalid_scope"
    | "disabled_client"
    | "org_internal";
  error_description: string;
};

export async function refreshGcpAccessToken(
  key: GcpKey
): Promise<[string, number]> {
  log.info({ key: key.hash }, "Entering GCP OAuth flow...");
  const { clientEmail, privateKey } = await getCredentialsFromGcpKey(key);

  // https://developers.google.com/identity/protocols/oauth2/service-account#authorizingrequests
  const jwt = await createSignedJWT(clientEmail, privateKey);
  log.info({ key: key.hash }, "Signed JWT, exchanging for access token...");
  const res = await axios.post<GoogleAuthResponse | GoogleAuthError>(
    authUrl,
    {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    },
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      validateStatus: () => true,
    }
  );
  const status = res.status;
  const headers = res.headers;
  const data = res.data;

  if ("error" in data || status >= 400) {
    log.error(
      { key: key.hash, status, headers, data },
      "Error from Google Identity API while getting access token."
    );
    throw new Error(
      `Google Identity API returned error: ${(data as GoogleAuthError).error}`
    );
  }

  log.info({ key: key.hash, exp: data.expires_in }, "Got access token.");
  return [data.access_token, data.expires_in];
}

export async function getCredentialsFromGcpKey(key: GcpKey) {
  const [projectId, clientEmail, region, rawPrivateKey] = key.key.split(":");
  if (!projectId || !clientEmail || !region || !rawPrivateKey) {
    log.error(
      { key: key.hash },
      "Cannot parse GCP credentials. Ensure they are in the format PROJECT_ID:CLIENT_EMAIL:REGION:PRIVATE_KEY, and ensure no whitespace or newlines are in the private key."
    );
    throw new Error("Cannot parse GCP credentials.");
  }

  if (!key.privateKey) {
    await importPrivateKey(key, rawPrivateKey);
  }

  return { projectId, clientEmail, region, privateKey: key.privateKey! };
}

async function createSignedJWT(
  email: string,
  pkey: crypto.webcrypto.CryptoKey
) {
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + 600;

  const header = { alg: "RS256", typ: "JWT" };

  const payload = {
    iss: email,
    aud: authUrl,
    iat: issued,
    exp: expires,
    scope,
  };

  const encodedHeader = urlSafeBase64Encode(JSON.stringify(header));
  const encodedPayload = urlSafeBase64Encode(JSON.stringify(payload));

  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pkey,
    new TextEncoder().encode(unsignedToken)
  );

  const encodedSignature = urlSafeBase64Encode(signature);
  return `${unsignedToken}.${encodedSignature}`;
}

async function importPrivateKey(key: GcpKey, rawPrivateKey: string) {
  log.info({ key: key.hash }, "Importing GCP private key...");
  const privateKey = rawPrivateKey
    .replace(
      /-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\r|\n|\\n/g,
      ""
    )
    .trim();
  const binaryKey = Buffer.from(privateKey, "base64");
  key.privateKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"]
  );
  log.info({ key: key.hash }, "GCP private key imported.");
}

function urlSafeBase64Encode(data: string | ArrayBuffer): string {
  let base64: string;
  if (typeof data === "string") {
    base64 = btoa(
      encodeURIComponent(data).replace(/%([0-9A-F]{2})/g, (match, p1) =>
        String.fromCharCode(parseInt("0x" + p1, 16))
      )
    );
  } else {
    base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
