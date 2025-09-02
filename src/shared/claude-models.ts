export interface ClaudeModelMapping {
  awsId: string;
  anthropicId: string;
  displayName: string;
}

export const claudeModels: ClaudeModelMapping[] = [
  { awsId: "anthropic.claude-v2", anthropicId: "claude-2", displayName: "Claude 2" },
  { awsId: "anthropic.claude-v2:1", anthropicId: "claude-2.1", displayName: "Claude 2.1" },
  { awsId: "anthropic.claude-3-haiku-20240307-v1:0", anthropicId: "claude-3-haiku-20240307", displayName: "Claude 3 Haiku" },
  { awsId: "anthropic.claude-3-5-haiku-20241022-v1:0", anthropicId: "claude-3-5-haiku-20241022", displayName: "Claude 3.5 Haiku" },
  { awsId: "anthropic.claude-3-sonnet-20240229-v1:0", anthropicId: "claude-3-sonnet-20240229", displayName: "Claude 3 Sonnet" },
  { awsId: "anthropic.claude-3-5-sonnet-20240620-v1:0", anthropicId: "claude-3-5-sonnet-20240620", displayName: "Claude 3.5 Sonnet (Old)" },
  { awsId: "anthropic.claude-3-5-sonnet-20241022-v2:0", anthropicId: "claude-3-5-sonnet-20241022", displayName: "Claude 3.5 Sonnet (New)" },
  { awsId: "anthropic.claude-3-5-sonnet-20241022-v2:0", anthropicId: "claude-3-5-sonnet-latest", displayName: "Claude 3.5 Sonnet (Latest)" },
  { awsId: "anthropic.claude-3-7-sonnet-20250219-v1:0", anthropicId: "claude-3-7-sonnet-20250219", displayName: "Claude 3.7 Sonnet" },
  { awsId: "anthropic.claude-3-7-sonnet-20250219-v1:0", anthropicId: "claude-3-7-sonnet-latest", displayName: "Claude 3.7 Sonnet (Latest)" },
  { awsId: "anthropic.claude-3-opus-20240229-v1:0", anthropicId: "claude-3-opus-20240229", displayName: "Claude 3 Opus" },
  { awsId: "anthropic.claude-3-opus-20240229-v1:0", anthropicId: "claude-3-opus-latest", displayName: "Claude 3 Opus (Latest)" },
  { awsId: "anthropic.claude-sonnet-4-20250514-v1:0", anthropicId: "claude-sonnet-4-20250514", displayName: "Claude 4 Sonnet" },
  { awsId: "anthropic.claude-sonnet-4-20250514-v1:0", anthropicId: "claude-sonnet-4-latest", displayName: "Claude 4 Sonnet (Latest)" },
  { awsId: "anthropic.claude-opus-4-20250514-v1:0", anthropicId: "claude-opus-4-20250514", displayName: "Claude 4 Opus" },
  { awsId: "anthropic.claude-opus-4-20250514-v1:0", anthropicId: "claude-opus-4-latest", displayName: "Claude 4 Opus (Latest)" },
  { awsId: "anthropic.claude-sonnet-4-20250514-v1:0", anthropicId: "claude-sonnet-4-0", displayName: "Claude 4 Sonnet" },
  { awsId: "anthropic.claude-opus-4-20250514-v1:0", anthropicId: "claude-opus-4-0", displayName: "Claude 4 Opus" },
];

export function findByAwsId(awsId: string): ClaudeModelMapping | undefined {
  return claudeModels.find(model => model.awsId === awsId);
}

export function findByAnthropicId(anthropicId: string): ClaudeModelMapping | undefined {
  return claudeModels.find(model => model.anthropicId === anthropicId);
}

export function getAllClaudeModels(): ClaudeModelMapping[] {
  return claudeModels;
} 