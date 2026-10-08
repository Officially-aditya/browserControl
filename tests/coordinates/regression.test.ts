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
          // Zoom changes CSS viewport size; DPR controls the native image pixel size.
          const effectiveViewportW = res.w / zoom;
          const effectiveViewportH = res.h / zoom;
          const imageWidth = res.w * dpr;
          const imageHeight = res.h * dpr;

          const mapper = CoordinateMapper.create(
            effectiveViewportW,
            effectiveViewportH,
            imageWidth,
            imageHeight,
            dpr,
            zoom
          );

          for (const pt of testGridPoints) {
            const targetX = Math.round(effectiveViewportW * pt.xRatio);
            const targetY = Math.round(effectiveViewportH * pt.yRatio);

            const imageX = targetX * imageWidth / effectiveViewportW;
            const imageY = targetY * imageHeight / effectiveViewportH;
            const mapped = mapper.toViewport(imageX, imageY);
            const deltaX = Math.abs(mapped.x - targetX);
            const deltaY = Math.abs(mapped.y - targetY);

            expect(deltaX).toBeLessThanOrEqual(2);
            expect(deltaY).toBeLessThanOrEqual(2);

            // Verify bounds
            expect(mapper.isInBounds(imageX, imageY)).toBe(true);
            expect(mapper.toImage(mapped.x, mapped.y).x).toBeCloseTo(imageX, 1);
            expect(mapper.toImage(mapped.x, mapped.y).y).toBeCloseTo(imageY, 1);
          }
        });
      }
    }
  }
});
