import { z } from "zod";
import {
  flattenOpenAIMessageContent,
  OpenAIV1ChatCompletionSchema,
} from "./openai";
import { APIFormatTransformer } from "./index";

const TextPartSchema = z.object({ 
  text: z.string(),
  thought: z.boolean().optional()
});

const InlineDataPartSchema = z.object({
  inlineData: z.object({
    mimeType: z.string(),
    data: z.string(),
  }),
});

const PartSchema = z.union([TextPartSchema, InlineDataPartSchema]);

const GoogleAIV1ContentSchema = z.object({
  parts: z
    .union([PartSchema, z.array(PartSchema)])
    .transform((val) => (Array.isArray(val) ? val : [val])),
  role: z.enum(["user", "model"]).optional(),
});


const SafetySettingsSchema = z
  .array(
    z.object({
      category: z.enum([
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
        "HARM_CATEGORY_CIVIC_INTEGRITY",
      ]),
      threshold: z.enum([
        "OFF",
        "BLOCK_NONE",
        "BLOCK_ONLY_HIGH",
        "BLOCK_MEDIUM_AND_ABOVE",
        "BLOCK_LOW_AND_ABOVE",
        "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
      ]),
    })
  )
  .optional();

const GoogleSearchToolSchema = z.object({
  googleSearch: z.object({}),
});

// Corrected: Directly assign the schema since there's only one tool type for now
const ToolSchema = GoogleSearchToolSchema;

export const GoogleAIV1GenerateContentSchema = z
  .object({
    model: z.string().max(100),
    stream: z.boolean().optional().default(false),
    contents: z.array(GoogleAIV1ContentSchema),
    tools: z.array(ToolSchema).optional(), // Uses the corrected ToolSchema
    safetySettings: SafetySettingsSchema,
    systemInstruction: GoogleAIV1ContentSchema.optional(),
    system_instruction: GoogleAIV1ContentSchema.optional(),
    generationConfig: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.coerce
          .number()
          .int()
          .optional()
          .default(16)
          .transform((v) => Math.min(v, 65536)),
        candidateCount: z.literal(1).optional(),
        topP: z.number().min(0).max(1).optional(),
        topK: z.number().min(0).max(500).optional(),
        stopSequences: z.array(z.string().max(500)).max(5).optional(),
        seed: z.number().int().optional(),
        frequencyPenalty: z.number().optional().default(0),
        presencePenalty: z.number().optional().default(0),
        thinkingConfig: z.object({
          includeThoughts: z.boolean().optional(),
          thinkingBudget: z.union([
            z.literal("auto"),
            z.number().int()
          ]).optional()
        }).optional(),
        responseModalities: z.any().optional(), // responseModalities: z.array(z.enum(["TEXT"])).optional()
      })
      .default({}),
  })
  .strip();
export type GoogleAIChatMessage = z.infer<
  typeof GoogleAIV1GenerateContentSchema
>["contents"][0];

export const transformOpenAIToGoogleAI: APIFormatTransformer<
  typeof GoogleAIV1GenerateContentSchema
> = async (req) => {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse({
    ...body,
    model: "gpt-3.5-turbo",
  });
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-Google AI request"
    );
    throw result.error;
  }

  const { messages, ...rest } = result.data;

  const foundNames = new Set<string>();
  const contents = messages
    .map((m) => {
      const role = m.role === "assistant" ? "model" : "user";
      const text = flattenOpenAIMessageContent(m.content);
      const propName = m.name?.trim();
      const textName =
        m.role === "system" ? "" : text.match(/^(.{0,50}?): /)?.[1]?.trim();
      const name =
        propName || textName || (role === "model" ? "Character" : "User");

      foundNames.add(name);

      const textPrefix = textName ? "" : `${name}: `;
      return {
        parts: [{ text: textPrefix + text }],
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      };
    })
    .reduce<GoogleAIChatMessage[]>((acc, msg) => {
      const last = acc[acc.length - 1];
      if (last?.role === msg.role && 'text' in last.parts[0] && 'text' in msg.parts[0]) {
        last.parts[0].text += "\n\n" + msg.parts[0].text;
      } else {
        acc.push(msg);
      }
      return acc;
    }, []);

  let stops = rest.stop
    ? Array.isArray(rest.stop)
      ? rest.stop
      : [rest.stop]
    : [];
  stops.push(...Array.from(foundNames).map((name) => `\n${name}:`));
  stops = [...new Set(stops)].slice(0, 5);

  let tools: z.infer<typeof ToolSchema>[] | undefined = undefined;
  let responseModalities: string[] | undefined = undefined;

  if (req.body.use_google_search === true) {
    req.log.info("Google Search tool requested.");
    tools = [{ googleSearch: {} }];
    responseModalities = ["TEXT"];
  }

  let thinkingConfig = undefined;
  if (body.generationConfig?.thinkingConfig || body.thinkingConfig) {
    thinkingConfig = body.generationConfig?.thinkingConfig || body.thinkingConfig;
  }

  return {
    model: req.body.model,
    stream: rest.stream,
    contents,
    tools: tools,
    generationConfig: {
      maxOutputTokens: rest.max_tokens,
      stopSequences: stops,
      topP: rest.top_p,
      topK: 40,
      temperature: rest.temperature,
      seed: rest.seed,
      frequencyPenalty: rest.frequency_penalty,
      presencePenalty: rest.presence_penalty,
      responseModalities: responseModalities,
      ...(thinkingConfig ? { thinkingConfig } : {})
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
    ],
    ...(req.body.system_instruction && { system_instruction: req.body.system_instruction }),
    ...(req.body.systemInstruction && { systemInstruction: req.body.systemInstruction }),
  };
};

export function containsImageContent(contents: GoogleAIChatMessage[]): boolean {
  return contents.some(content => {
    const parts = Array.isArray(content.parts) ? content.parts : [content.parts];
    return parts.some(part => 'inlineData' in part);
  });
}
