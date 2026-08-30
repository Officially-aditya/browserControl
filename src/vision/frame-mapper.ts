import {
  NormalizedCoordinate,
  NormalizedRegion,
  NormalizedComputerAction,
} from "./types.js";
import { VisionFrame, VisionFrameSourceRegion } from "./frame.js";

/**
 * Maps normalized coordinates (0-1000) from models on a VisionFrame back to
 * the authoritative browser Observation image pixel space.
 */
export class VisionFrameMapper {
  /**
   * Convert normalized point (0-1000) to pixel coordinate within the given VisionFrame
   */
  public static normalizedToFrame(
    point: NormalizedCoordinate,
    frame: VisionFrame
  ): { x: number; y: number } {
    const frameX = (point.x / 1000) * frame.width;
    const frameY = (point.y / 1000) * frame.height;
    return { x: frameX, y: frameY };
  }

  /**
   * Convert pixel coordinate in VisionFrame to pixel coordinate in the original Observation
   */
  public static frameToSource(
    frameX: number,
    frameY: number,
    frame: VisionFrame
  ): { x: number; y: number } {
    if (frame.width <= 0 || frame.height <= 0) {
      throw new Error(`Invalid frame dimensions: width=${frame.width}, height=${frame.height}`);
    }
    const ratioX = frameX / frame.width;
    const ratioY = frameY / frame.height;
    const sourceX = frame.sourceRegion.x + ratioX * frame.sourceRegion.width;
    const sourceY = frame.sourceRegion.y + ratioY * frame.sourceRegion.height;
    return { x: sourceX, y: sourceY };
  }

  /**
   * Convert normalized point (0-1000) on VisionFrame directly to pixel coordinate in the original Observation
   */
  public static normalizedToSource(
    point: NormalizedCoordinate,
    frame: VisionFrame
  ): { x: number; y: number } {
    const ratioX = point.x / 1000;
    const ratioY = point.y / 1000;
    const sourceX = frame.sourceRegion.x + ratioX * frame.sourceRegion.width;
    const sourceY = frame.sourceRegion.y + ratioY * frame.sourceRegion.height;
    return { x: sourceX, y: sourceY };
  }

  /**
   * Convert normalized region (0-1000) on VisionFrame to source region in the original Observation
   */
  public static normalizedRegionToSourceRegion(
    region: NormalizedRegion,
    frame: VisionFrame
  ): VisionFrameSourceRegion {
    const sourceX = frame.sourceRegion.x + (region.x / 1000) * frame.sourceRegion.width;
    const sourceY = frame.sourceRegion.y + (region.y / 1000) * frame.sourceRegion.height;
    const sourceWidth = (region.width / 1000) * frame.sourceRegion.width;
    const sourceHeight = (region.height / 1000) * frame.sourceRegion.height;

    return {
      x: sourceX,
      y: sourceY,
      width: sourceWidth,
      height: sourceHeight,
    };
  }

  /**
   * Convert an array of normalized coordinates (e.g. drag path) to original Observation coordinates
   */
  public static normalizedPathToSource(
    path: NormalizedCoordinate[],
    frame: VisionFrame
  ): Array<{ x: number; y: number }> {
    return path.map((point) => this.normalizedToSource(point, frame));
  }

  /**
   * Translate a normalized model ComputerAction on a VisionFrame into a standard executable ComputerAction
   * payload bound to the original Observation (with observationId and screenshot pixel coordinates).
   */
  public static mapNormalizedComputerAction(
    action: NormalizedComputerAction,
    frame: VisionFrame
  ): Record<string, any> {
    switch (action.type) {
      case "click":
      case "double_click":
      case "move":
      case "down":
      case "up": {
        const sourcePt = this.normalizedToSource({ x: action.x, y: action.y }, frame);
        return {
          ...action,
          observationId: frame.sourceObservationId,
          x: Math.round(sourcePt.x),
          y: Math.round(sourcePt.y),
        };
      }

      case "scroll": {
        const sourcePt = this.normalizedToSource({ x: action.x, y: action.y }, frame);
        return {
          ...action,
          observationId: frame.sourceObservationId,
          x: Math.round(sourcePt.x),
          y: Math.round(sourcePt.y),
        };
      }

      case "drag": {
        const sourcePath = this.normalizedPathToSource(action.path, frame);
        return {
          ...action,
          observationId: frame.sourceObservationId,
          path: sourcePath.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        };
      }

      case "type":
      case "keypress":
      case "key_down":
      case "key_up":
      case "wait": {
        return { ...action };
      }
    }
  }
}
