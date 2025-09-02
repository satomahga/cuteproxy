import { Request } from "express";

/**
 * Claude Opus 4.1 has stricter API validation that doesn't allow both temperature 
 * and top_p parameters to be specified simultaneously. This function validates and 
 * adjusts the request parameters for Claude Opus 4.1 models ONLY.
 * 
 * Rules:
 * - If both parameters are at default values (1.0), omit top_p
 * - If only one parameter is at default, omit the default one
 * - If both are non-default, throw an error
 */
export function validateClaude41OpusParameters(req: Request): void {
  const model = req.body.model;
  
  // Only apply this validation to Claude Opus 4.1 models
  if (!isClaude41OpusModel(model)) {
    return;
  }
  
  const temperature = req.body.temperature;
  const topP = req.body.top_p;
  
  // If neither parameter is specified, no validation needed
  if (temperature === undefined && topP === undefined) {
    return;
  }
  
  // Default values for Claude API
  const DEFAULT_TEMPERATURE = 1.0;
  const DEFAULT_TOP_P = 1.0;
  
  const tempIsDefault = temperature === undefined || temperature === DEFAULT_TEMPERATURE;
  const topPIsDefault = topP === undefined || topP === DEFAULT_TOP_P;
  
  // If both are at default values, omit top_p (keep temperature)
  if (tempIsDefault && topPIsDefault) {
    delete req.body.top_p;
    req.log?.info("Claude Opus 4.1: Both temperature and top_p at default, omitting top_p");
    return;
  }
  
  // If only one is at default, omit the default one
  if (tempIsDefault && !topPIsDefault) {
    delete req.body.temperature;
    req.log?.info("Claude Opus 4.1: Temperature at default, omitting temperature");
    return;
  }
  
  if (!tempIsDefault && topPIsDefault) {
    delete req.body.top_p;
    req.log?.info("Claude Opus 4.1: top_p at default, omitting top_p");
    return;
  }
  
  // If both are non-default, throw an error
  if (!tempIsDefault && !topPIsDefault) {
    throw new Error(
      "Claude Opus 4.1 does not support both temperature and top_p parameters being set to non-default values simultaneously. " +
      "Please specify only one of these parameters or set one to its default value (1.0)."
    );
  }
}

/**
 * Checks if the given model is a Claude Opus 4.1 model.
 * This includes all provider formats for Claude Opus 4.1 ONLY.
 */
function isClaude41OpusModel(model: string): boolean {
  if (!model) return false;
  
  // Anthropic API format
  if (model.includes("claude-opus-4-1")) return true;
  
  // AWS Bedrock format
  if (model.includes("anthropic.claude-opus-4-1")) return true;
  
  // GCP Vertex AI format
  if (model.includes("claude-opus-4-1@")) return true;
  
  return false;
}
