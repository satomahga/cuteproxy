import { z } from "zod";
import { Request } from "express";
import { OpenAIV1ChatCompletionSchema } from "./openai";
import { APIFormatTransformer } from "./index";

// Extend the Express Request type to include multimodal content
declare global {
  namespace Express {
    interface Request {
      multimodalContent?: {
        prompt?: string;
        images?: string[];
      };
    }
  }
}

// https://platform.openai.com/docs/api-reference/images/create
export const OpenAIV1ImagesGenerationSchema = z
  .object({
    prompt: z.string().max(32000), // gpt-image-1 supports up to 32000 chars
    model: z.string().max(100).optional(),
    // Support for image inputs (multimodal capability of gpt-image-1)
    image: z.union([
      z.string(), // single image (base64 or URL)
      z.array(z.string()) // array of images
    ]).optional(),
    mask: z.string().optional(), // mask image for editing
    // Different quality options based on model
    quality: z
      .union([
        z.enum(["standard", "hd"]), // dall-e-3 options
        z.enum(["high", "medium", "low"]), // gpt-image-1 options
        z.literal("auto") // default for gpt-image-1
      ])
      .optional()
      .default("standard"),
    n: z.number().int().min(1).max(10).optional().default(1), // gpt-image-1 supports up to 10
    response_format: z.enum(["url", "b64_json"]).optional(), // Note: gpt-image-1 always returns b64_json
    // Enhanced size options for gpt-image-1
    size: z
      .union([
        // dalle models
        z.enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"]),
        // gpt-image-1 models (adds landscape, portrait, auto)
        z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"])
      ])
      .optional()
      .default("1024x1024"),
    style: z.enum(["vivid", "natural"]).optional().default("vivid"), // dall-e-3 only
    // New gpt-image-1 specific parameters
    background: z.enum(["transparent", "opaque", "auto"]).optional(), // gpt-image-1 only
    moderation: z.enum(["low", "auto"]).optional(), // gpt-image-1 only
    output_compression: z.number().int().min(0).max(100).optional(), // gpt-image-1 only
    output_format: z.enum(["png", "jpeg", "webp"]).optional(), // gpt-image-1 only
    user: z.string().max(500).optional(),
  })
  .strip();

// Takes the last chat message and uses it verbatim as the image prompt.
export const transformOpenAIToOpenAIImage: APIFormatTransformer<
  typeof OpenAIV1ImagesGenerationSchema
> = async (req) => {
  const { body } = req;
  const result = OpenAIV1ChatCompletionSchema.safeParse(body);
  if (!result.success) {
    req.log.warn(
      { issues: result.error.issues, body },
      "Invalid OpenAI-to-OpenAI-image request"
    );
    throw result.error;
  }

  const { messages } = result.data;
  const userMessage = messages.filter((m) => m.role === "user").pop();
  if (!userMessage) {
    throw new Error("No user message found in the request.");
  }
  
  const content = userMessage.content;
  
  // Handle array content (multimodal content with text and images)
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const imageParts: string[] = [];
    
    // Process content parts, extracting text and images
    content.forEach(part => {
      if (typeof part === 'string') {
        textParts.push(part);
      } else if (part.type === 'image_url') {
        // Extract image URL or base64 data from the content
        const imageUrl = typeof part.image_url === 'string' 
          ? part.image_url 
          : part.image_url.url;
        imageParts.push(imageUrl);
      }
    });
    
    // Join all text parts to form the prompt
    const prompt = textParts.join('\n');
    
    // For gpt-image-1, we'll pass both the text prompt and image(s)
    req.multimodalContent = {
      prompt,
      images: imageParts
    };
  } else if (typeof content !== 'string') {
    throw new Error("Image generation prompt must be a text message or multimodal content.");
  }

  if (body.stream) {
    throw new Error(
      "Streaming is not supported for image generation requests."
    );
  }

  // Some frontends do weird things with the prompt, like prefixing it with a
  // character name or wrapping the entire thing in quotes. We will look for
  // the index of "Image:" and use everything after that as the prompt.

  // Determine if this is a multimodal request (with images)  
  const isMultimodalRequest = Array.isArray(content) && req.multimodalContent?.images && req.multimodalContent.images.length > 0;
  
  // Check if this is a request for gpt-image-1
  const isGptImageRequest = body.model?.includes("gpt-image") || false;
  
  // Only enforce the "Image:" prefix for non-multimodal, non-gpt-image-1 requests
  if (!isMultimodalRequest && !isGptImageRequest && typeof content === 'string') {
    const textIndex = content.toLowerCase().indexOf("image:");
    if (textIndex === -1) {
      throw new Error(
        `Start your prompt with 'Image:' followed by a description of the image you want to generate (received: ${content}).`
      );
    }
  }
  
  // TODO: Add some way to specify parameters via chat message
  // Determine which model to use (gpt-image-1 or dall-e-3)
  const isGptImage = body.model?.includes("gpt-image") || false;
  
  // For gpt-image-1, add the 'Image:' prefix if it's missing but only for string content
  let modifiedStringContent = typeof content === 'string' ? content : '';
  if (isGptImageRequest && typeof content === 'string' && !content.toLowerCase().includes("image:")) {
    req.log.info("Adding 'Image:' prefix to gpt-image-1 prompt");
    modifiedStringContent = `Image: ${content}`;
    // Store this in the request object for later use
    req.multimodalContent = req.multimodalContent || {};
    req.multimodalContent.prompt = modifiedStringContent;
  }

  // Get the correct text prompt either from multimodal content or plain string content
  let textPrompt: string | undefined;
  let index = -1;
  
  if (Array.isArray(content)) {
    // For array content, use the prompt from multimodal content if available
    textPrompt = req.multimodalContent?.prompt;
  } else if (typeof content === 'string') {
    // For string content, use the modified content which might have the Image: prefix for gpt-image-1
    const contentToProcess = isGptImageRequest ? modifiedStringContent : content;
    
    // Find the "Image:" prefix in the content
    index = contentToProcess.toLowerCase().indexOf("image:");
    
    // For gpt-image-1, we might have just added the prefix, so we need to handle both cases
    if (index !== -1) {
      textPrompt = contentToProcess.slice(index + 6).trim();
    } else if (isGptImageRequest) {
      // For gpt-image-1, use the whole content if no prefix is found
      textPrompt = content; // Use the original content without prefix
    } else {
      // For other models, default to the content as-is
      textPrompt = contentToProcess;
    }
  }
  
  // Validate that we have a text prompt
  if (!textPrompt) {
    throw new Error("No text prompt found in the request.");
  }

  // Determine the exact model being used
  let modelName = "dall-e-2"; // Default
  
  if (isGptImage) {
    modelName = "gpt-image-1";
  } else if (body.model?.includes("dall-e-3")) {
    modelName = "dall-e-3";
  } else if (body.model?.includes("dall-e-2")) {
    modelName = "dall-e-2";
  } else {
    // If no specific model requested, default to dall-e-3
    modelName = "dall-e-3";
  }
  
  // Start with basic parameters common to all models
  const transformed: any = {
    model: modelName,
    prompt: textPrompt,
  };

  // Add model-specific parameters
  if (modelName === "gpt-image-1") {
    // GPT Image specific parameters - Ensure we only include parameters that are valid for gpt-image-1
    transformed.quality = "auto"; // Default quality for gpt-image-1
    transformed.size = "1024x1024"; // Default size (square)
    transformed.moderation = "low"; // Always set moderation to low for gpt-image-1
    
    // Optional GPT Image parameters
    if (body.background) transformed.background = body.background;
    if (body.output_format) transformed.output_format = body.output_format;
    if (body.output_compression) transformed.output_compression = body.output_compression;
    
    // Handle specific quality settings for gpt-image-1
    if (body.quality && ["high", "medium", "low", "auto"].includes(body.quality)) {
      transformed.quality = body.quality;
    }
    
    // Handle specific size settings for gpt-image-1
    if (body.size && ["1024x1024", "1536x1024", "1024x1536", "auto"].includes(body.size)) {
      transformed.size = body.size;
    }
    
    // IMPORTANT: Remove any style parameter as it's not supported by gpt-image-1
    delete transformed.style;
    
    // Log what we're sending for debugging
    req.log.info({ model: "gpt-image-1", allowedParams: Object.keys(transformed) }, "Filtered parameters for gpt-image-1");
    
    // No response_format for gpt-image-1 as it always returns b64_json
  } else if (modelName === "dall-e-3") {
    // DALL-E 3 specific parameters
    transformed.size = "1024x1024"; // Default size
    transformed.response_format = "url"; // Default format
    transformed.quality = "standard"; // Default quality
    
    // Handle DALL-E 3 style parameter
    if (body.style && ["vivid", "natural"].includes(body.style)) {
      transformed.style = body.style;
    } else {
      transformed.style = "vivid"; // Default style
    }
    
    // Handle specific quality settings for dall-e-3
    if (body.quality && ["standard", "hd"].includes(body.quality)) {
      transformed.quality = body.quality;
    }
    
    // Handle specific size settings for dall-e-3
    if (body.size && ["1024x1024", "1792x1024", "1024x1792"].includes(body.size)) {
      transformed.size = body.size;
    }
  } else {
    // DALL-E 2 specific parameters
    transformed.size = "1024x1024"; // Default size
    transformed.response_format = "url"; // Default format
    
    // NO quality parameter for dall-e-2
    // Explicitly remove the quality parameter before sending
    delete transformed.quality;
    
    // Handle specific size settings for dall-e-2
    if (body.size && ["256x256", "512x512", "1024x1024"].includes(body.size)) {
      transformed.size = body.size;
    }
  }
  
  // Handle common parameters
  if (body.n && !isNaN(parseInt(body.n))) {
    // For dall-e-3, only n=1 is supported
    if (modelName === "dall-e-3" && parseInt(body.n) > 1) {
      transformed.n = 1;
    } else {
      transformed.n = parseInt(body.n);
    }
  }
  
  // Handle response_format for non-gpt-image models
  if (!isGptImage && body.response_format && ["url", "b64_json"].includes(body.response_format)) {
    transformed.response_format = body.response_format;
  }
  
  // If this is gpt-image-1 and we have image content, add it to the transformed request
  if (isGptImage && req.multimodalContent?.images && req.multimodalContent.images.length > 0) {
    // For the edit endpoint, we need to format the images properly
    transformed.image = req.multimodalContent.images.length === 1 
      ? req.multimodalContent.images[0] 
      : req.multimodalContent.images;
    
    // Any request with images for gpt-image-1 should use the edits endpoint
    req.log.info(`${req.multimodalContent.images.length} image(s) detected for gpt-image-1, using images/edits endpoint`);
    if (req.path.startsWith("/v1/chat/completions")) {
      req.url = req.url.replace("/v1/chat/completions", "/v1/images/edits");
    }
  }
  // For dall-e-2, we need to make sure we don't introduce unsupported parameters
  // due to default values in the schema. Let's bypass Zod schema validation here
  // for dall-e-2 and only include the supported parameters.
  if (modelName === "dall-e-2") {
    // Only include parameters that dall-e-2 supports
    const filteredTransformed: any = {};
    
    // List of parameters supported by dall-e-2
    const supportedParams = [
      "model", "prompt", "n", "size", "response_format", "user"
    ];
    
    // Copy only supported parameters
    for (const param of supportedParams) {
      if (transformed[param] !== undefined) {
        filteredTransformed[param] = transformed[param];
      }
    }
    
    // Log what we're sending
    req.log.info({ model: "dall-e-2", params: Object.keys(filteredTransformed) }, "Filtered parameters for dall-e-2");
    
    return filteredTransformed;
  }
  
  // For other models, use the schema as normal
  return OpenAIV1ImagesGenerationSchema.parse(transformed);
};
