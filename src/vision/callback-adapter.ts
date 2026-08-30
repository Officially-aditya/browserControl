import { VisionModelAdapter, validateVisionDecision } from "./adapter.js";
import { VisionCapabilities, VisionDecision, VisionRequest } from "./types.js";

export type VisionDecideFunction = (
  request: VisionRequest
) => Promise<VisionDecision | unknown> | VisionDecision | unknown;

export interface CallbackVisionAdapterOptions {
  /** Identifier for this adapter instance (default: 'callback-vision-adapter') */
  id?: string;

  /** Declared multimodal vision capabilities */
  capabilities?: Partial<VisionCapabilities>;

  /** User-supplied decision callback function */
  decide: VisionDecideFunction;
}

/**
 * Universal callback adapter that connects any external model API, custom agent pipeline,
 * LangChain, LlamaIndex, OpenAI/Anthropic/Gemini/Ollama SDK, or raw HTTP client to the VisionAgent runtime.
 */
export class CallbackVisionAdapter implements VisionModelAdapter {
  public readonly id: string;
  public readonly capabilities: VisionCapabilities;
  private decideFn: VisionDecideFunction;

  constructor(options: CallbackVisionAdapterOptions) {
    this.id = options.id ?? "callback-vision-adapter";
    this.capabilities = {
      maxImages: options.capabilities?.maxImages ?? 1,
      supportsStructuredOutput: options.capabilities?.supportsStructuredOutput ?? true,
      preferredFormat: options.capabilities?.preferredFormat ?? "webp",
      preferredLongEdge: options.capabilities?.preferredLongEdge ?? 1440,
      supportsHighDetailImages: options.capabilities?.supportsHighDetailImages ?? true,
    };
    this.decideFn = options.decide;
  }

  /**
   * Delegates perception decision to user callback and ensures returned decision conforms to VisionDecision schema.
   */
  public async decide(input: VisionRequest): Promise<VisionDecision> {
    const rawResult = await this.decideFn(input);
    return validateVisionDecision(rawResult);
  }
}
