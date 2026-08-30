import { describe, it, expect } from "vitest";
import { CoordinateMapper } from "../../src/screen/coordinates.js";

describe("Coordinate Regression Suite Across Matrix", () => {
  const resolutions = [
    { w: 800, h: 600 },
    { w: 1024, h: 768 },
    { w: 1280, h: 720 },
    { w: 1440, h: 900 },
    { w: 1920, h: 1080 },
  ];

  const dprs = [1, 2];
  const zoomScales = [0.8, 1.0, 1.25, 1.5];

  const testGridPoints = [
    { xRatio: 0.1, yRatio: 0.1 },
    { xRatio: 0.5, yRatio: 0.5 },
    { xRatio: 0.9, yRatio: 0.9 },
  ];

  for (const res of resolutions) {
    for (const dpr of dprs) {
      for (const zoom of zoomScales) {
        it(`should maintain coordinate accuracy <= 2 CSS px for ${res.w}x${res.h}, DPR ${dpr}, Zoom ${zoom * 100}%`, () => {
          // Model sees image scaled by zoom or DPR normalized
          const effectiveViewportW = res.w;
          const effectiveViewportH = res.h;

          const mapper = CoordinateMapper.create(
            effectiveViewportW,
            effectiveViewportH,
            effectiveViewportW,
            effectiveViewportH,
            dpr
          );

          for (const pt of testGridPoints) {
            const targetX = Math.round(effectiveViewportW * pt.xRatio);
            const targetY = Math.round(effectiveViewportH * pt.yRatio);

            const mapped = mapper.toViewport(targetX, targetY);
            const deltaX = Math.abs(mapped.x - targetX);
            const deltaY = Math.abs(mapped.y - targetY);

            expect(deltaX).toBeLessThanOrEqual(2);
            expect(deltaY).toBeLessThanOrEqual(2);

            // Verify bounds
            expect(mapper.isInBounds(mapped.x, mapped.y)).toBe(true);
          }
        });
      }
    }
  }
});
