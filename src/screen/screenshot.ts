import { TabSession } from "../chrome/session.js";
import { ViewportManager } from "./viewport.js";
import { CoordinateMapper } from "./coordinates.js";
import { decodeImageDimensions } from "./image-decoder.js";
import { Observation } from "../protocol/results.js";

export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  optimizeForSpeed?: boolean;
  showCursor?: boolean;
}

export interface StoredObservation {
  observationId: string;
  targetId: string;
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  imageWidth: number;
  imageHeight: number;
  mapper: CoordinateMapper;
  timestamp: number;
}

export class ObservationStore {
  private observations = new Map<string, StoredObservation>();
  private maxStored = 50;

  public save(obs: StoredObservation): void {
    if (this.observations.size >= this.maxStored) {
      const oldestKey = this.observations.keys().next().value;
      if (oldestKey) this.observations.delete(oldestKey);
    }
    this.observations.set(obs.observationId, obs);
  }

  public get(observationId: string): StoredObservation | undefined {
    return this.observations.get(observationId);
  }

  public clear(): void {
    this.observations.clear();
  }
}

export class ScreenshotService {
  private session: TabSession;
  private viewportManager: ViewportManager;
  private observationStore: ObservationStore;
  private lastMapper: CoordinateMapper | null = null;
  private lastCursorPosition: { x: number; y: number } | null = null;
  private obsCounter = 0;

  constructor(
    session: TabSession,
    viewportManager: ViewportManager,
    observationStore: ObservationStore
  ) {
    this.session = session;
    this.viewportManager = viewportManager;
    this.observationStore = observationStore;
  }

  public setCursorPosition(x: number, y: number): void {
    this.lastCursorPosition = { x, y };
  }

  public get currentCursorPosition(): { x: number; y: number } | null {
    return this.lastCursorPosition;
  }

  public get currentMapper(): CoordinateMapper | null {
    return this.lastMapper;
  }

  /**
   * Capture viewport screenshot and decode real image dimensions
   */
  public async capture(options: ScreenshotOptions = {}): Promise<Observation> {
    const format = options.format || "png";
    const metrics = await this.viewportManager.getMetrics();
    const visual = metrics.cssVisualViewport;

    const cssViewportWidth = Math.round(visual.clientWidth);
    const cssViewportHeight = Math.round(visual.clientHeight);

    const captureParams: any = {
      format,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: visual.pageX,
        y: visual.pageY,
        width: visual.clientWidth,
        height: visual.clientHeight,
        scale: 1,
      },
    };

    if (format === "jpeg" || format === "webp") {
      captureParams.quality = options.quality ?? 85;
    }

    if (options.optimizeForSpeed) {
      captureParams.optimizeForSpeed = true;
    }

    const res = await this.session.send<{ data: string }>("Page.captureScreenshot", captureParams);
    const imageBuffer = Buffer.from(res.data, "base64");

    // Decode actual image pixel dimensions from binary header
    const decoded = decodeImageDimensions(imageBuffer);
    const imageWidth = decoded.width > 0 ? decoded.width : cssViewportWidth;
    const imageHeight = decoded.height > 0 ? decoded.height : cssViewportHeight;

    const mapper = CoordinateMapper.create(
      cssViewportWidth,
      cssViewportHeight,
      imageWidth,
      imageHeight,
      metrics.devicePixelRatio,
      visual.zoom || 1
    );
    this.lastMapper = mapper;

    const obsId = `obs_${++this.obsCounter}_${Date.now()}`;

    // Store in observation history for validation
    this.observationStore.save({
      observationId: obsId,
      targetId: this.session.targetId || "",
      url: this.session.currentUrl || "",
      viewportWidth: cssViewportWidth,
      viewportHeight: cssViewportHeight,
      imageWidth,
      imageHeight,
      mapper,
      timestamp: Date.now(),
    });

    const activeDialog = this.session.activeDialog || undefined;

    const observation: Observation = {
      observationId: obsId,
      image: res.data,
      imageWidth,
      imageHeight,
      viewportWidth: cssViewportWidth,
      viewportHeight: cssViewportHeight,
      width: cssViewportWidth,
      height: cssViewportHeight,
      targetId: this.session.targetId || "",
      url: this.session.currentUrl || "",
      title: this.session.currentTitle || "",
      coordinateSpace: mapper.coordinateSpace,
      timestamp: Date.now(),
      cursorPosition: this.lastCursorPosition || undefined,
      activeDialog,
    };

    return observation;
  }
}
