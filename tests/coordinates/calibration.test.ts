import { describe, it, expect } from "vitest";
import { CoordinateMapper } from "../../src/screen/coordinates.js";

describe("CoordinateMapper & Calibration Unit Matrix", () => {
  it("should preserve 1:1 coordinate identity when image matches viewport", () => {
    const mapper = CoordinateMapper.create(1440, 900, 1440, 900);
    const space = mapper.coordinateSpace;

    expect(space.scaleX).toBe(1);
    expect(space.scaleY).toBe(1);

    const pt1 = mapper.toViewport(100, 100);
    expect(pt1).toEqual({ x: 100, y: 100 });

    const pt2 = mapper.toViewport(500, 300);
    expect(pt2).toEqual({ x: 500, y: 300 });

    const pt3 = mapper.toViewport(1000, 700);
    expect(pt3).toEqual({ x: 1000, y: 700 });
  });

  it("should scale coordinates correctly when downscaled image is provided", () => {
    // Viewport is 1440x900, image is 960x600 (scale factor 1.5)
    const mapper = CoordinateMapper.create(1440, 900, 960, 600);
    const space = mapper.coordinateSpace;

    expect(space.scaleX).toBe(1.5);
    expect(space.scaleY).toBe(1.5);

    const vp = mapper.toViewport(640, 400);
    expect(vp).toEqual({ x: 960, y: 600 });

    const roundtrip = mapper.toImage(vp.x, vp.y);
    expect(roundtrip).toEqual({ x: 640, y: 400 });
  });

  it("should enforce boundary validation and clamping", () => {
    const mapper = CoordinateMapper.create(1024, 768, 1024, 768);

    expect(mapper.clamp(-50, 400)).toEqual({ x: 0, y: 400 });
    expect(mapper.clamp(1200, 400)).toEqual({ x: 1024, y: 400 });
    expect(mapper.clamp(500, -20)).toEqual({ x: 500, y: 0 });
    expect(mapper.clamp(500, 900)).toEqual({ x: 500, y: 768 });

    expect(mapper.isInBounds(500, 400)).toBe(true);
    expect(mapper.isInBounds(-10, 400)).toBe(false);
    expect(mapper.isInBounds(1050, 400)).toBe(false);
  });

  it("should guarantee calibration precision within 2 CSS pixels for all key targets", () => {
    const knownTargets = [
      { x: 100, y: 100 },
      { x: 500, y: 300 },
      { x: 1000, y: 700 },
    ];

    const mapper = CoordinateMapper.create(1440, 900, 1440, 900);

    for (const target of knownTargets) {
      const mapped = mapper.toViewport(target.x, target.y);
      const deltaX = Math.abs(mapped.x - target.x);
      const deltaY = Math.abs(mapped.y - target.y);

      expect(deltaX).toBeLessThanOrEqual(2);
      expect(deltaY).toBeLessThanOrEqual(2);
    }
  });
});
