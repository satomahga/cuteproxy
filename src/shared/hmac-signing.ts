/** Module for generating and verifying HMAC signatures. */

import crypto from "crypto";
import { SECRET_SIGNING_KEY } from "../config";

/**
 * Generates a HMAC signature for the given message. Optionally salts the
 * key with a provided string.
 */
export function signMessage(msg: any, salt: string = ""): string {
  const hmac = crypto.createHmac("sha256", SECRET_SIGNING_KEY + salt);
  if (typeof msg === "object") {
    hmac.update(JSON.stringify(msg));
  } else {
    hmac.update(msg);
  }
  return hmac.digest("hex");
}
