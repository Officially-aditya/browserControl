import { describe, it, expect } from "vitest";
import { VisionFrame, createOverviewFrame, createRegionFrame } from "../../src/vision/frame.js";
import { VisionFrameMapper } from "../../src/vision/frame-mapper.js";
import { NormalizedComputerAction } from "../../src/vision/types.js";

describe("VisionFrameMapper Coordinate Transformations", () => {
  // Mock full-resolution 1920x1080 screenshot
  const fullOverviewFrame: VisionFrame = createOverviewFrame({
    sourceObservationId: "obs_test_100",
    visualEpoch: 1,
    image: "fake_base64",
    mimeType: "image/webp",
    width: 1440, // scaled overview
    height: 810,
    sourceImageWidth: 1920, // native source observation dimensions
    sourceImageHeight: 1080,
  });

  // Mock cropped region of 600x400 at offset (300, 200) in original observation space
  const cropRegionFrame: VisionFrame = createRegionFrame({
    sourceObservationId: "obs_test_100",
    visualEpoch: 1,
    image: "fake_crop_base64",
    mimeType: "image/png",
    width: 600,
    height: 400,
    sourceRegion: {
      x: 300,
      y: 200,
      width: 600,
      height: 400,
    },
  });

  describe("1. Full-Frame Coordinate Mapping", () => {
    it("should map normalized center (500, 500) to center of source observation (960, 540)", () => {
      const pt = VisionFrameMapper.normalizedToSource({ x: 500, y: 500 }, fullOverviewFrame);
      expect(pt.x).toBe(960);
      expect(pt.y).toBe(540);
    });

    it("should map normalized corners (0,0) and (1000,1000) to observation boundaries", () => {
      const topLeft = VisionFrameMapper.normalizedToSource({ x: 0, y: 0 }, fullOverviewFrame);
      expect(topLeft.x).toBe(0);
      expect(topLeft.y).toBe(0);

      const bottomRight = VisionFrameMapper.normalizedToSource({ x: 1000, y: 1000 }, fullOverviewFrame);
      expect(bottomRight.x).toBe(1920);
      expect(bottomRight.y).toBe(1080);
    });

    it("should map intermediate normalized coordinates accurately", () => {
      // 25% across X, 75% down Y
      const pt = VisionFrameMapper.normalizedToSource({ x: 250, y: 750 }, fullOverviewFrame);
      expect(pt.x).toBe(480);
      expect(pt.y).toBe(810);
    });
  });

  describe("2. Cropped Region Coordinate Mapping", () => {
    it("should map normalized center (500, 500) of crop to exact center of source region", () => {
      // Source region is x: 300..900, y: 200..600 -> center is (600, 400)
      const pt = VisionFrameMapper.normalizedToSource({ x: 500, y: 500 }, cropRegionFrame);
      expect(pt.x).toBe(600);
      expect(pt.y).toBe(400);
    });

    it("should map crop corners correctly to source region boundaries", () => {
      const topLeft = VisionFrameMapper.normalizedToSource({ x: 0, y: 0 }, cropRegionFrame);
      expect(topLeft.x).toBe(300);
      expect(topLeft.y).toBe(200);

      const topRight = VisionFrameMapper.normalizedToSource({ x: 1000, y: 0 }, cropRegionFrame);
      expect(topRight.x).toBe(900);
      expect(topRight.y).toBe(200);

      const bottomLeft = VisionFrameMapper.normalizedToSource({ x: 0, y: 1000 }, cropRegionFrame);
      expect(bottomLeft.x).toBe(300);
      expect(bottomLeft.y).toBe(600);

      const bottomRight = VisionFrameMapper.normalizedToSource({ x: 1000, y: 1000 }, cropRegionFrame);
      expect(bottomRight.x).toBe(900);
      expect(bottomRight.y).toBe(600);
    });
  });

  describe("3. Nested Coordinate Conversion (Overview -> Region -> Action)", () => {
    it("should accurately convert nested region inspection coordinates", () => {
      // Model requests inspect_region on overview at { x: 200, y: 300, width: 400, height: 300 }
      const requestedRegion = { x: 200, y: 300, width: 400, height: 300 };
      const sourceRegion = VisionFrameMapper.normalizedRegionToSourceRegion(
        requestedRegion,
        fullOverviewFrame
      );

      // In source pixels (1920x1080):
      // x = 0 + 0.2 * 1920 = 384
      // y = 0 + 0.3 * 1080 = 324
      // width = 0.4 * 1920 = 768
      // height = 0.3 * 1080 = 324
      expect(sourceRegion.x).toBe(384);
      expect(sourceRegion.y).toBe(324);
      expect(sourceRegion.width).toBe(768);
      expect(sourceRegion.height).toBe(324);

      // Create new region frame from this crop
      const nestedFrame = createRegionFrame({
        sourceObservationId: "obs_test_100",
        visualEpoch: 1,
        image: "crop_b64",
        mimeType: "image/png",
        width: 768,
        height: 324,
        sourceRegion,
      });

      // Now model clicks at (500, 500) inside the nested crop
      const clickPt = VisionFrameMapper.normalizedToSource({ x: 500, y: 500 }, nestedFrame);
      // Expected source: 384 + 0.5 * 768 = 768, 324 + 0.5 * 324 = 486
      expect(clickPt.x).toBe(768);
      expect(clickPt.y).toBe(486);
    });
  });

  describe("4. Drag Path & Action Translation", () => {
    it("should translate normalized drag path into Observation pixel path", () => {
      const normalizedPath = [
        { x: 100, y: 500 },
        { x: 500, y: 500 },
        { x: 900, y: 500 },
      ];

      const sourcePath = VisionFrameMapper.normalizedPathToSource(normalizedPath, cropRegionFrame);
      expect(sourcePath).toHaveLength(3);

      // crop is x: 300..900, y: 200..600
      expect(sourcePath[0]).toEqual({ x: 360, y: 400 });
      expect(sourcePath[1]).toEqual({ x: 600, y: 400 });
      expect(sourcePath[2]).toEqual({ x: 840, y: 400 });
    });

    it("should map normalized click action into executable ComputerAction with observationId", () => {
      const normClick: NormalizedComputerAction = {
        type: "click",
        x: 500,
        y: 500,
        button: "left",
      };

      const mapped = VisionFrameMapper.mapNormalizedComputerAction(normClick, cropRegionFrame);
      expect(mapped).toEqual({
        type: "click",
        observationId: "obs_test_100",
        x: 600,
        y: 400,
        button: "left",
      });
    });

    it("should preserve non-spatial actions without modification", () => {
      const normType: NormalizedComputerAction = {
        type: "type",
        text: "hello world",
        method: "auto",
      };
      const mapped = VisionFrameMapper.mapNormalizedComputerAction(normType, cropRegionFrame);
      expect(mapped).toEqual(normType);
    });
  });

  describe("5. Boundary Containment", () => {
    it("should ensure all normalized mappings stay within original observation bounds", () => {
      const points = [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 0, y: 1000 },
        { x: 1000, y: 1000 },
        { x: 333, y: 777 },
      ];

      for (const pt of points) {
        const sourcePt = VisionFrameMapper.normalizedToSource(pt, fullOverviewFrame);
        expect(sourcePt.x).toBeGreaterThanOrEqual(0);
        expect(sourcePt.x).toBeLessThanOrEqual(fullOverviewFrame.sourceRegion.width);
        expect(sourcePt.y).toBeGreaterThanOrEqual(0);
        expect(sourcePt.y).toBeLessThanOrEqual(fullOverviewFrame.sourceRegion.height);
      }
    });
  });
});
