import { config } from "../config";
import { ModelFamily } from "./models";

// Prices are per 1 million tokens.
const MODEL_PRICING: Record<ModelFamily, { input: number; output: number } | undefined> = {
  "deepseek": { input: 0.55, output: 2.19 }, // DeepSeek Reasoner (standard price, input cache miss)
  "xai": { input: 5.6, output: 16.8 }, // Grok: Derived from avg $14/1M (assuming 1:3 in/out ratio) - needs official pricing
  "gpt41": { input: 2.00, output: 8.00 },
  "azure-gpt41": { input: 2.00, output: 8.00 },
  "gpt41-mini": { input: 0.40, output: 1.60 },
  "azure-gpt41-mini": { input: 0.40, output: 1.60 },
  "gpt41-nano": { input: 0.10, output: 0.40 },
  "azure-gpt41-nano": { input: 0.10, output: 0.40 },
  "gpt5": { input: 1.25, output: 10.00 },
  "azure-gpt5": { input: 1.25, output: 10.00 },
  "gpt5-mini": { input: 0.25, output: 2.00 },
  "azure-gpt5-mini": { input: 0.25, output: 2.00 },
  "gpt5-nano": { input: 0.05, output: 0.40 },
  "azure-gpt5-nano": { input: 0.05, output: 0.40 },
  "gpt5-chat-latest": { input: 1.25, output: 10.00 },
  "azure-gpt5-chat-latest": { input: 1.25, output: 10.00 },
  "gpt45": { input: 75.00, output: 150.00 }, // Example, needs verification if this model family is still current with this pricing
  "azure-gpt45": { input: 75.00, output: 150.00 }, // Example, needs verification
  "gpt4o": { input: 2.50, output: 10.00 },
  "azure-gpt4o": { input: 2.50, output: 10.00 },
  "gpt4-turbo": { input: 10.00, output: 30.00 },
  "azure-gpt4-turbo": { input: 10.00, output: 30.00 },
  "o1-pro": { input: 150.00, output: 600.00 },
  "azure-o1-pro": { input: 150.00, output: 600.00 },
  "o3-pro": { input: 20.00, output: 80.00 },
  "azure-o3-pro": { input: 20.00, output: 80.00 },
  "o1": { input: 15.00, output: 60.00 },
  "azure-o1": { input: 15.00, output: 60.00 },
  "o1-mini": { input: 1.10, output: 4.40 },
  "azure-o1-mini": { input: 1.10, output: 4.40 },
  "o3-mini": { input: 1.10, output: 4.40 },
  "azure-o3-mini": { input: 1.10, output: 4.40 },
  "o3": { input: 2.00, output: 8.00 },
  "azure-o3": { input: 10.00, output: 40.00 },
  "o4-mini": { input: 1.10, output: 4.40 },
  "azure-o4-mini": { input: 1.10, output: 4.40 },
  "codex-mini": { input: 1.50, output: 6.00 },
  "azure-codex-mini": { input: 1.50, output: 6.00 },
  "gpt4-32k": { input: 60.00, output: 120.00 },
  "azure-gpt4-32k": { input: 60.00, output: 120.00 },
  "gpt4": { input: 30.00, output: 60.00 },
  "azure-gpt4": { input: 30.00, output: 60.00 },
  "turbo": { input: 0.15, output: 0.60 }, // Maps to GPT-4o mini
  "azure-turbo": { input: 0.15, output: 0.60 },
  "dall-e": { input: 0, output: 0 }, // Pricing is per image, not token based in this context.
  "azure-dall-e": { input: 0, output: 0 }, // Pricing is per image.
  "gpt-image": { input: 0, output: 0 }, // Complex pricing (text, image input, image output tokens), handle separately.
  "azure-gpt-image": { input: 0, output: 0 }, // Complex pricing.
  "claude": { input: 3.00, output: 15.00 }, // Anthropic Claude Sonnet 4
  "aws-claude": { input: 3.00, output: 15.00 },
  "gcp-claude": { input: 3.00, output: 15.00 },
  "claude-opus": { input: 15.00, output: 75.00 }, // Anthropic Claude Opus 4
  "aws-claude-opus": { input: 15.00, output: 75.00 },
  "gcp-claude-opus": { input: 15.00, output: 75.00 },
  "mistral-tiny": { input: 0.04, output: 0.04 }, // Using old price if no new API price found
  "aws-mistral-tiny": { input: 0.04, output: 0.04 },
  "mistral-small": { input: 0.10, output: 0.30 }, // Mistral Small 3.1
  "aws-mistral-small": { input: 0.10, output: 0.30 },
  "mistral-medium": { input: 0.40, output: 2.00 }, // Mistral Medium 3
  "aws-mistral-medium": { input: 0.40, output: 2.00 },
  "mistral-large": { input: 2.00, output: 6.00 },
  "aws-mistral-large": { input: 2.00, output: 6.00 },
  "gemini-flash": { input: 0.15, output: 0.60 }, // Updated to Gemini 2.5 Flash Preview (text input, non-thinking output)
  "gemini-pro": { input: 1.25, output: 10.00 }, // Updated to Gemini 2.5 Pro Preview (<=200k tokens)
  "gemini-ultra": { input: 25.00, output: 75.00 }, // Estimated based on Gemini Pro (5-10x) and character to token conversion. Official per-token pricing needed.
  // Ensure all ModelFamily entries from models.ts are covered or have a default.
  // Adding placeholders for families in models.ts but not yet priced here.
  "cohere": { input: 0.15, output: 0.60 }, // Updated to Command R
  "qwen": { input: 1.40, output: 2.80 }, // Qwen-plus, as an example
  "moonshot": { input: 0.6, output: 2.5 }, // Moonshot kimi k2
};

export function getTokenCostDetailsUsd(model: ModelFamily, inputTokens: number, outputTokens?: number): { inputCost: number, outputCost: number, totalCost: number } {
  const pricing = MODEL_PRICING[model];

  if (!pricing) {
    console.warn(`Pricing not found for model family: ${model}. Returning 0 cost for all components.`);
    return { inputCost: 0, outputCost: 0, totalCost: 0 };
  }

  const costPerMillionInputTokens = pricing.input;
  const costPerMillionOutputTokens = pricing.output;

  const inputCost = (costPerMillionInputTokens / 1_000_000) * Math.max(0, inputTokens);
  const outputCost = (costPerMillionOutputTokens / 1_000_000) * Math.max(0, outputTokens ?? 0);

  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

export function getTokenCostUsd(model: ModelFamily, inputTokens: number, outputTokens?: number): number {
  return getTokenCostDetailsUsd(model, inputTokens, outputTokens).totalCost;
}

export function prettyTokens(tokens: number): string {
  const absTokens = Math.abs(tokens);
  if (absTokens < 1000) {
    return tokens.toString();
  } else if (absTokens < 1000000) {
    return (tokens / 1000).toFixed(1) + "k";
  } else if (absTokens < 1000000000) {
    return (tokens / 1000000).toFixed(2) + "m";
  } else {
    return (tokens / 1000000000).toFixed(3) + "b";
  }
}

export function getCostSuffix(cost: number) {
  if (!config.showTokenCosts) return "";
  return ` ($${cost.toFixed(2)})`;
}
