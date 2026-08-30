import { ChromeController } from "../controller.js";
import { Observation } from "../protocol/results.js";
import { NormalizedRegion } from "./types.js";
import {
  VisionFrame,
  VisionFrameSourceRegion,
  createOverviewFrame,
  createRegionFrame,
} from "./frame.js";
import { VisionFrameMapper } from "./frame-mapper.js";
import { decodeImageDimensions } from "../screen/image-decoder.js";

export interface VisionCaptureConfig {
  overviewFormat?: "png" | "jpeg" | "webp";
  overviewQuality?: number;
  overviewLongEdge?: number;
  regionFormat?: "png" | "jpeg" | "webp";
  regionQuality?: number;
  showCursor?: boolean;
}

/**
 * Adaptive perception capture service that manages multi-fidelity screenshot captures:
 * - Lightweight Overview frames (e.g. WebP / JPEG scaled) for broad situational reasoning.
 * - High-Detail Region frames (CDP hardware-clipped at native resolution) for precision targets.
 */
export class VisionCaptureService {
  private controller: ChromeController;
  private config: VisionCaptureConfig;

  constructor(controller: ChromeController, config: VisionCaptureConfig = {}) {
    this.controller = controller;
    this.config = {
      overviewFormat: "webp",
      overviewQuality: 85,
      overviewLongEdge: 1440,
      regionFormat: "png",
      regionQuality: 90,
      showCursor: false,
      ...config,
    };
  }

  /**
   * Capture an overview screenshot and return both the authoritative browser Observation
   * and the corresponding VisionFrame.
   */
  public async captureOverview(options?: Partial<VisionCaptureConfig>): Promise<{
    observation: Observation;
    frame: VisionFrame;
  }> {
    const format = options?.overviewFormat || this.config.overviewFormat || "webp";
    const quality = options?.overviewQuality || this.config.overviewQuality || 85;
    const showCursor = options?.showCursor ?? this.config.showCursor ?? false;

    const observation = await this.controller.observe({
      format,
      quality,
      showCursor,
    });

    const frame = createOverviewFrame({
      sourceObservationId: observation.observationId,
      visualEpoch: observation.visualEpoch,
      image: observation.image,
      mimeType: `image/${format}`,
      width: observation.imageWidth,
      height: observation.imageHeight,
      sourceImageWidth: observation.imageWidth,
      sourceImageHeight: observation.imageHeight,
    });

    return { observation, frame };
  }

  /**
   * Capture a high-detail clipped region frame for a requested normalized sub-region
   * using CDP hardware surface clipping.
   */
  public async captureRegion(
    region: NormalizedRegion,
    source: VisionFrame | Observation,
    options?: Partial<VisionCaptureConfig>
  ): Promise<VisionFrame> {
    const sourceObservationId =
      "sourceObservationId" in source ? source.sourceObservationId : source.observationId;
    const visualEpoch = source.visualEpoch;

    // 1. Calculate sourceRegion in original Observation image pixels
    let sourceRegion: VisionFrameSourceRegion;
    if ("kind" in source) {
      sourceRegion = VisionFrameMapper.normalizedRegionToSourceRegion(region, source);
    } else {
      sourceRegion = {
        x: (region.x / 1000) * source.imageWidth,
        y: (region.y / 1000) * source.imageHeight,
        width: (region.width / 1000) * source.imageWidth,
        height: (region.height / 1000) * source.imageHeight,
      };
    }

    // 2. Retrieve CoordinateMapper for this observation
    const storedObs = this.controller.observationStore.get(sourceObservationId);
    const mapper = storedObs?.mapper;
    if (!mapper) {
      throw {
        errorCode: "STALE_OBSERVATION",
        message: `Cannot capture region: Observation '${sourceObservationId}' is expired or not found.`,
      };
    }

    // 3. Convert image pixels to CSS viewport coordinates for CDP clip
    const cssX = sourceRegion.x * mapper.scaleX;
    const cssY = sourceRegion.y * mapper.scaleY;
    const cssWidth = sourceRegion.width * mapper.scaleX;
    const cssHeight = sourceRegion.height * mapper.scaleY;

    const metrics = await this.controller.viewportManager.getMetrics();
    const visual = metrics.cssVisualViewport;

    const format = options?.regionFormat || this.config.regionFormat || "png";
    const quality = options?.regionQuality || this.config.regionQuality || 90;

    const captureParams: any = {
      format,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: visual.pageX + cssX,
        y: visual.pageY + cssY,
        width: cssWidth,
        height: cssHeight,
        scale: 1,
      },
    };

    if (format === "jpeg" || format === "webp") {
      captureParams.quality = quality;
    }

    const res = await this.controller.session.send<{ data: string }>(
      "Page.captureScreenshot",
      captureParams
    );
    const imageBuffer = Buffer.from(res.data, "base64");
    const decoded = decodeImageDimensions(imageBuffer);

    return createRegionFrame({
      sourceObservationId,
      visualEpoch,
      image: res.data,
      mimeType: `image/${format}`,
      width: decoded.width > 0 ? decoded.width : Math.round(cssWidth * metrics.devicePixelRatio),
      height: decoded.height > 0 ? decoded.height : Math.round(cssHeight * metrics.devicePixelRatio),
      sourceRegion,
    });
  }
}
