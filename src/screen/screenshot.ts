import { PNG } from "pngjs";
import { TabSession } from "../chrome/session.js";
import { ViewportManager } from "./viewport.js";
import { CoordinateMapper } from "./coordinates.js";
import { decodeImageDimensions } from "./image-decoder.js";
import { InputStateManager } from "../input/state.js";
import { Observation, CursorPosition } from "../protocol/results.js";

export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  optimizeForSpeed?: boolean;
  showCursor?: boolean;
}

export interface StoredObservation {
  observationId: string;
  targetId: string;
  visualEpoch: number;
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

  public isValid(observationId: string, currentTargetId: string, currentEpoch: number): boolean {
    const stored = this.observations.get(observationId);
    if (!stored) return false;
    return stored.targetId === currentTargetId && stored.visualEpoch === currentEpoch;
  }

  public invalidateTarget(targetId: string): void {
    for (const [id, obs] of this.observations.entries()) {
      if (obs.targetId === targetId) {
        this.observations.delete(id);
      }
    }
  }

  public clear(): void {
    this.observations.clear();
  }
}

export class ScreenshotService {
  private session: TabSession;
  private viewportManager: ViewportManager;
  private observationStore: ObservationStore;
  private inputState: InputStateManager;
  private lastMapper: CoordinateMapper | null = null;
  private obsCounter = 0;

  constructor(
    session: TabSession,
    viewportManager: ViewportManager,
    observationStore: ObservationStore,
    inputState: InputStateManager
  ) {
    this.session = session;
    this.viewportManager = viewportManager;
    this.observationStore = observationStore;
    this.inputState = inputState;
  }

  public get currentMapper(): CoordinateMapper | null {
    return this.lastMapper;
  }

  /**
   * Draw a small crosshair pointer onto a PNG buffer at image-space (x, y)
   */
  private drawCursorOnPng(pngBuffer: Buffer, targetX: number, targetY: number): Buffer {
    try {
      const png = PNG.sync.read(pngBuffer);
      const width = png.width;
      const height = png.height;
      const radius = 6;

      const setPixel = (px: number, py: number, r: number, g: number, b: number, a = 255) => {
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const idx = (width * py + px) << 2;
          png.data[idx] = r;
          png.data[idx + 1] = g;
          png.data[idx + 2] = b;
          png.data[idx + 3] = a;
        }
      };

      const cx = Math.round(targetX);
      const cy = Math.round(targetY);

      // Draw red crosshair with white border
      for (let offset = -radius; offset <= radius; offset++) {
        // Horizontal bar
        setPixel(cx + offset, cy - 1, 255, 255, 255);
        setPixel(cx + offset, cy, 239, 68, 68); // #ef4444
        setPixel(cx + offset, cy + 1, 255, 255, 255);

        // Vertical bar
        setPixel(cx - 1, cy + offset, 255, 255, 255);
        setPixel(cx, cy + offset, 239, 68, 68);
        setPixel(cx + 1, cy + offset, 255, 255, 255);
      }

      // Center dot
      setPixel(cx, cy, 255, 255, 255);

      return Buffer.from(PNG.sync.write(png));
    } catch {
      return pngBuffer;
    }
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
    let imageBuffer: Buffer = Buffer.from(res.data, "base64");

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

    const cursorVpX = this.inputState.cursorX;
    const cursorVpY = this.inputState.cursorY;
    const imgCursor = mapper.toImage(cursorVpX, cursorVpY);

    if (options.showCursor && format === "png") {
      imageBuffer = this.drawCursorOnPng(imageBuffer, imgCursor.x, imgCursor.y);
    }

    const obsId = `obs_${++this.obsCounter}_${Date.now()}`;
    const epoch = this.session.visualEpoch;

    // Store in observation history with visualEpoch
    this.observationStore.save({
      observationId: obsId,
      targetId: this.session.targetId || "",
      visualEpoch: epoch,
      url: this.session.currentUrl || "",
      viewportWidth: cssViewportWidth,
      viewportHeight: cssViewportHeight,
      imageWidth,
      imageHeight,
      mapper,
      timestamp: Date.now(),
    });

    const activeDialog = this.session.activeDialog || undefined;

    const cursorPosition: CursorPosition = {
      imageX: imgCursor.x,
      imageY: imgCursor.y,
      viewportX: cursorVpX,
      viewportY: cursorVpY,
      x: cursorVpX,
      y: cursorVpY,
    };

    const observation: Observation = {
      observationId: obsId,
      visualEpoch: epoch,
      image: imageBuffer.toString("base64"),
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
      cursorPosition,
      activeDialog,
    };

    return observation;
  }
}
