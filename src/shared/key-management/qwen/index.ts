import { QwenKeyProvider } from "./provider";

// Export only the provider and the checker, not the QwenKey interface directly
export { QwenKeyProvider } from "./provider";
export { QwenKeyChecker } from "./checker";
// Re-export the QwenKey interface from provider to maintain compatibility
export type { QwenKey } from "./provider";

export const qwenKeyProvider = new QwenKeyProvider();
