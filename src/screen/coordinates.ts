import { CoordinateSpace } from "../protocol/results.js";

export class CoordinateMapper {
  private space: CoordinateSpace;

  constructor(space: CoordinateSpace) {
    this.space = space;
  }

  public static create(
    viewportWidth: number,
    viewportHeight: number,
    imageWidth: number,
    imageHeight: number,
    dpr = 1,
    zoom = 1
  ): CoordinateMapper {
    const scaleX = imageWidth > 0 ? viewportWidth / imageWidth : 1;
    const scaleY = imageHeight > 0 ? viewportHeight / imageHeight : 1;

    return new CoordinateMapper({
      imageWidth,
      imageHeight,
      viewportWidth,
      viewportHeight,
      scaleX,
      scaleY,
      devicePixelRatio: dpr,
      zoom,
    });
  }

  public get coordinateSpace(): CoordinateSpace {
    return { ...this.space };
  }

  public get imageWidth(): number {
    return this.space.imageWidth;
  }

  public get imageHeight(): number {
    return this.space.imageHeight;
  }

  public get viewportWidth(): number {
    return this.space.viewportWidth;
  }

  public get viewportHeight(): number {
    return this.space.viewportHeight;
  }

  public get scaleX(): number {
    return this.space.scaleX;
  }

  public get scaleY(): number {
    return this.space.scaleY;
  }

  /**
   * Convert model-space / screenshot coordinate to CDP CSS-pixel viewport coordinate
   */
  public toViewport(modelX: number, modelY: number): { x: number; y: number } {
    const x = modelX * this.space.scaleX;
    const y = modelY * this.space.scaleY;
    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
    };
  }

  /**
   * Convert CDP CSS-pixel coordinate to model-space / screenshot coordinate
   */
  public toImage(viewportX: number, viewportY: number): { x: number; y: number } {
    const x = viewportX / this.space.scaleX;
    const y = viewportY / this.space.scaleY;
    return {
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
    };
  }

  /**
   * Validate that model coordinate falls within screenshot / image boundaries
   */
  public validateBounds(
    modelX: number,
    modelY: number,
    tolerance = 2
  ): { valid: boolean; error?: string } {
    const minX = -tolerance;
    const maxX = this.space.imageWidth + tolerance;
    const minY = -tolerance;
    const maxY = this.space.imageHeight + tolerance;

    if (modelX < minX || modelX > maxX || modelY < minY || modelY > maxY) {
      return {
        valid: false,
        error: `Coordinate (${modelX}, ${modelY}) is out of bounds for image dimensions (${this.space.imageWidth}x${this.space.imageHeight})`,
      };
    }
    return { valid: true };
  }

  public isInBounds(modelX: number, modelY: number, tolerance = 2): boolean {
    return this.validateBounds(modelX, modelY, tolerance).valid;
  }

  /**
   * Clamp viewport coordinates to valid [0, viewportWidth/Height]
   */
  public clamp(x: number, y: number): { x: number; y: number } {
    const clampedX = Math.max(0, Math.min(x, this.space.viewportWidth));
    const clampedY = Math.max(0, Math.min(y, this.space.viewportHeight));
    return { x: clampedX, y: clampedY };
  }
}
