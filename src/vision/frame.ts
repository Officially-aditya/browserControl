import { NormalizedRegion } from "./types.js";

/**
 * Pixel bounds in the original Observation image coordinate space
 */
export interface VisionFrameSourceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * VisionFrame represents an optimized visual frame (full overview or high-detail region crop)
 * presented to a vision model. It preserves the exact mapping back to the authoritative Observation.
 */
export interface VisionFrame {
  frameId: string;
  sourceObservationId: string;
  visualEpoch: number;
  image: string; // base64 encoded image
  mimeType: string; // e.g. "image/png", "image/jpeg", "image/webp"
  width: number; // width of this frame in pixels
  height: number; // height of this frame in pixels
  sourceRegion: VisionFrameSourceRegion; // Pixel bounds in original Observation image coordinate space
  kind: "overview" | "region";
  timestamp: number;
}

let frameCounter = 0;

/**
 * Helper to construct an overview VisionFrame from an Observation
 */
export function createOverviewFrame(params: {
  sourceObservationId: string;
  visualEpoch: number;
  image: string;
  mimeType: string;
  width: number;
  height: number;
  sourceImageWidth: number;
  sourceImageHeight: number;
}): VisionFrame {
  return {
    frameId: `vframe_overview_${++frameCounter}_${Date.now()}`,
    sourceObservationId: params.sourceObservationId,
    visualEpoch: params.visualEpoch,
    image: params.image,
    mimeType: params.mimeType,
    width: params.width,
    height: params.height,
    sourceRegion: {
      x: 0,
      y: 0,
      width: params.sourceImageWidth,
      height: params.sourceImageHeight,
    },
    kind: "overview",
    timestamp: Date.now(),
  };
}

/**
 * Helper to construct a cropped high-detail region VisionFrame
 */
export function createRegionFrame(params: {
  sourceObservationId: string;
  visualEpoch: number;
  image: string;
  mimeType: string;
  width: number;
  height: number;
  sourceRegion: VisionFrameSourceRegion;
}): VisionFrame {
  return {
    frameId: `vframe_region_${++frameCounter}_${Date.now()}`,
    sourceObservationId: params.sourceObservationId,
    visualEpoch: params.visualEpoch,
    image: params.image,
    mimeType: params.mimeType,
    width: params.width,
    height: params.height,
    sourceRegion: params.sourceRegion,
    kind: "region",
    timestamp: Date.now(),
  };
}
