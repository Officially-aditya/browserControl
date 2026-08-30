import { VisionModelAdapter, validateVisionDecision } from "./adapter.js";
import { VisionCapabilities, VisionDecision, VisionRequest } from "./types.js";

export interface OpenAIVisionAdapterConfig {
  /** API Key (falls back to process.env.OPENAI_API_KEY) */
  apiKey?: string;
  /** Multimodal model name (default: 'gpt-4o-mini') */
  model?: string;
  /** Base URL for OpenAI-compatible endpoint (default: 'https://api.openai.com/v1') */
  baseUrl?: string;
  /** Sampling temperature (default: 0.1) */
  temperature?: number;
  /** Maximum response tokens (default: 1024) */
  maxTokens?: number;
  /** Custom request headers (e.g. for OpenRouter or proxies) */
  customHeaders?: Record<string, string>;
  /** Optional custom fetch implementation (useful for testing or proxying) */
  fetchFn?: typeof fetch;
}

const SYSTEM_PROMPT = `You are a visual browser automation agent.
You receive screenshots of a web browser and must output your next action to accomplish the user objective.

COORDINATE CONVENTION:
- All (x, y) coordinates must be normalized integers from 0 to 1000.
- (0, 0) is the top-left corner of the image, and (1000, 1000) is the bottom-right corner.
- If looking at a cropped region frame, (0, 0) is the top-left of that cropped region.

OUTPUT FORMAT:
Output ONLY valid JSON adhering to the following schema with NO surrounding conversational text:

For clicking or typing:
{
  "type": "computer_action",
  "action": {
    "type": "click" | "double_click" | "move" | "type" | "drag" | "scroll" | "keypress" | "key_down" | "key_up" | "wait",
    "x": 0-1000,
    "y": 0-1000,
    "button": "left" | "right" | "middle",
    "text": "text to type",
    "path": [{"x": 0-1000, "y": 0-1000}],
    "deltaX": 0,
    "deltaY": 0
  },
  "certainty": "certain" | "likely" | "uncertain",
  "intent": "Brief explanation of this step"
}

For high-resolution region inspection when uncertain:
{
  "type": "inspect_region",
  "region": {
    "x": 0-1000,
    "y": 0-1000,
    "width": 0-1000,
    "height": 0-1000
  },
  "certainty": "uncertain",
  "reasoning": "Reason for inspecting"
}

For browser navigation or dialogs:
{
  "type": "browser_action",
  "action": {
    "type": "navigate" | "handle_dialog",
    "url": "https://...",
    "accept": true
  },
  "certainty": "certain"
}

When the objective is completed:
{
  "type": "done",
  "success": true,
  "result": "Description of completed task"
}
`;

/**
 * Reference Multimodal Model Adapter for OpenAI, OpenRouter, and OpenAI-compatible VLMs.
 * Uses native fetch with zero external SDK dependencies.
 */
export class OpenAIVisionAdapter implements VisionModelAdapter {
  public readonly id: string;
  public readonly capabilities: VisionCapabilities;
  private config: OpenAIVisionAdapterConfig;
  private fetchFn: typeof fetch;

  constructor(config: OpenAIVisionAdapterConfig = {}) {
    this.config = {
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      temperature: 0.1,
      maxTokens: 1024,
      ...config,
    };
    this.id = `openai-${this.config.model}`;
    this.capabilities = {
      maxImages: 2,
      supportsStructuredOutput: true,
      preferredFormat: "webp",
      preferredLongEdge: 1440,
      supportsHighDetailImages: true,
    };
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Format multimodal messages payload from VisionRequest
   */
  public formatMessages(input: VisionRequest): any[] {
    const userContent: any[] = [];

    // 1. Text Prompt
    const textPrompt = [
      input.historySummary ? `${input.historySummary}\n` : "",
      `CURRENT STEP: ${input.stepIndex} of ${input.maxSteps}`,
      input.currentUrl ? `PAGE URL: ${input.currentUrl}` : "",
      `OBJECTIVE: ${input.objective}`,
      `\nDetermine the next visual action to take. Output JSON only.`,
    ].filter(Boolean).join("\n");

    userContent.push({ type: "text", text: textPrompt });

    // 2. Multimodal Image Frames
    for (const frame of input.frames) {
      if (frame.image) {
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:${frame.mimeType};base64,${frame.image}`,
            detail: frame.kind === "region" ? "high" : "low",
          },
        });
      }
    }

    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];
  }

  /**
   * Parse raw text response into validated VisionDecision
   */
  public parseResponse(responseText: string): VisionDecision {
    let cleanText = responseText.trim();
    // Strip markdown code block fences if present
    if (cleanText.startsWith("```json")) {
      cleanText = cleanText.slice(7);
    } else if (cleanText.startsWith("```")) {
      cleanText = cleanText.slice(3);
    }
    if (cleanText.endsWith("```")) {
      cleanText = cleanText.slice(0, -3);
    }
    cleanText = cleanText.trim();

    try {
      const parsed = JSON.parse(cleanText);
      return validateVisionDecision(parsed);
    } catch (err: any) {
      throw new Error(`Failed to parse valid VisionDecision from model response: ${err.message}\nRaw: ${responseText}`);
    }
  }

  /**
   * Query multimodal model and return validated VisionDecision
   */
  public async decide(input: VisionRequest): Promise<VisionDecision> {
    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY || "";
    const endpoint = `${this.config.baseUrl!.replace(/\/+$/, "")}/chat/completions`;

    const messages = this.formatMessages(input);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...this.config.customHeaders,
    };

    const response = await this.fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`OpenAI Vision API call failed (${response.status}): ${errBody}`);
    }

    const data: any = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI Vision response contained no message content");
    }

    return this.parseResponse(content);
  }
}
