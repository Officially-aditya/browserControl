import { afterEach, describe, it, expect, vi } from "vitest";
import {
  randomBetween, gaussianRandom, keyHoldMs, charFlightMs, wordPauseMs,
  shortcutHoldMs, bezierPath, stepTimings, preClickDelayMs, clickHoldMs,
  clickJitter, humanClickPoint, scrollChunks, scrollStepDelayMs, wordCount, minDwellMs,
} from "../../extension/human-input.js";

describe("human-input timing helpers", () => {
  it("randomBetween returns values in range", () => {
    for (let i = 0; i < 100; i++) {
      const v = randomBetween(10, 50);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(50);
    }
  });

  it("gaussianRandom clusters around mean", () => {
    const values = Array.from({ length: 500 }, () => gaussianRandom(100, 10));
    const mean = values.reduce((a, b) => a + b) / values.length;
    expect(mean).toBeGreaterThan(85);
    expect(mean).toBeLessThan(115);
  });

  it("keyHoldMs returns realistic hold times", () => {
    for (let i = 0; i < 50; i++) {
      const v = keyHoldMs();
      expect(v).toBeGreaterThanOrEqual(40);
      expect(v).toBeLessThan(200);
    }
  });

  it("charFlightMs returns inter-character delays", () => {
    for (let i = 0; i < 50; i++) {
      const v = charFlightMs();
      expect(v).toBeGreaterThanOrEqual(55);
      expect(v).toBeLessThanOrEqual(140);
    }
  });

  it("wordPauseMs returns word-boundary pauses", () => {
    for (let i = 0; i < 50; i++) {
      const v = wordPauseMs();
      expect(v).toBeGreaterThanOrEqual(120);
      expect(v).toBeLessThanOrEqual(300);
    }
  });

  it("shortcutHoldMs returns shortcut hold times", () => {
    for (let i = 0; i < 50; i++) {
      const v = shortcutHoldMs();
      expect(v).toBeGreaterThanOrEqual(25);
      expect(v).toBeLessThanOrEqual(55);
    }
  });
});

describe("bezierPath", () => {
  it("returns at least start and end for short distances", () => {
    const path = bezierPath({ x: 100, y: 100 }, { x: 102, y: 101 });
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0]).toEqual({ x: 100, y: 100 });
    expect(path[path.length - 1]).toEqual({ x: 102, y: 101 });
  });

  it("generates multiple intermediate points for long distances", () => {
    const path = bezierPath({ x: 0, y: 0 }, { x: 500, y: 300 });
    expect(path.length).toBeGreaterThan(5);
    // First and last points should be near start/end
    expect(path[0].x).toBe(0);
    expect(path[0].y).toBe(0);
    expect(path[path.length - 1].x).toBe(500);
    expect(path[path.length - 1].y).toBe(300);
  });

  it("all points are finite numbers", () => {
    const path = bezierPath({ x: 50, y: 50 }, { x: 800, y: 600 });
    for (const p of path) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("humanClickPoint", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([[200, 40], [12, 12], [2, 1], [0.5, 0.75]])(
    "keeps randomized points strictly inside a %s by %s target",
    (width, height) => {
      const left = 10.3;
      const top = 20.6;
      const random = vi.spyOn(Math, "random");
      for (const value of [0, 0.001, 0.25, 0.5, 0.999999]) {
        random.mockReturnValue(value);
        for (const rect of [
          { left, top, width, height },
          { x: left + width / 2, y: top + height / 2, width, height },
        ]) {
          const point = humanClickPoint(rect);
          expect(point.x).toBeGreaterThan(left);
          expect(point.x).toBeLessThan(left + width);
          expect(point.y).toBeGreaterThan(top);
          expect(point.y).toBeLessThan(top + height);
        }
      }
    },
  );

  it("varies the landing point across the component", () => {
    const rect = { left: 10, top: 20, width: 200, height: 40 };
    const random = vi.spyOn(Math, "random").mockReturnValue(0.2);
    const first = humanClickPoint(rect);
    random.mockReturnValue(0.8);
    expect(humanClickPoint(rect)).not.toEqual(first);
  });
});

describe("stepTimings", () => {
  it("returns pathLength - 1 delay values", () => {
    const t = stepTimings(10);
    expect(t).toHaveLength(9);
  });

  it("all delays are positive", () => {
    const t = stepTimings(15);
    for (const d of t) {
      expect(d).toBeGreaterThan(0);
    }
  });
});

describe("click timing helpers", () => {
  it("preClickDelayMs in range", () => {
    for (let i = 0; i < 30; i++) {
      const v = preClickDelayMs();
      expect(v).toBeGreaterThanOrEqual(35);
      expect(v).toBeLessThanOrEqual(80);
    }
  });

  it("clickHoldMs in range", () => {
    for (let i = 0; i < 30; i++) {
      const v = clickHoldMs();
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThanOrEqual(95);
    }
  });

  it("clickJitter returns small offsets", () => {
    for (let i = 0; i < 30; i++) {
      const j = clickJitter();
      expect(Math.abs(j.dx)).toBeLessThanOrEqual(2);
      expect(Math.abs(j.dy)).toBeLessThanOrEqual(2);
    }
  });
});

describe("scrollChunks", () => {
  it("breaks large deltas into chunks", () => {
    const chunks = scrollChunks(0, -600);
    expect(chunks.length).toBeGreaterThan(1);
    const totalDy = chunks.reduce((acc, c) => acc + c.dy, 0);
    expect(totalDy).toBeCloseTo(-600, 1);
  });

  it("preserves direction for both axes", () => {
    const chunks = scrollChunks(200, -300);
    for (const c of chunks) {
      expect(c.dx).toBeGreaterThan(0);
      expect(c.dy).toBeLessThan(0);
    }
  });

  it("returns single chunk for small deltas", () => {
    const chunks = scrollChunks(0, -30);
    expect(chunks.length).toBe(1);
  });

  it("scrollStepDelayMs in range", () => {
    for (let i = 0; i < 30; i++) {
      const v = scrollStepDelayMs();
      expect(v).toBeGreaterThanOrEqual(12);
      expect(v).toBeLessThanOrEqual(30);
    }
  });
});

describe("pacing", () => {
  it("wordCount counts words correctly", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount(null)).toBe(0);
    expect(wordCount("hello")).toBe(1);
    expect(wordCount("hello world")).toBe(2);
    expect(wordCount("  spaces   between   words  ")).toBe(3);
    expect(wordCount("one\ntwo\tthree")).toBe(3);
  });

  it("minDwellMs returns 0 for empty pages", () => {
    expect(minDwellMs(0)).toBe(0);
  });

  it("minDwellMs clamps to at least 800ms", () => {
    expect(minDwellMs(1)).toBe(800);
    expect(minDwellMs(3)).toBe(800);
  });

  it("minDwellMs scales with word count", () => {
    // 100 words at 250 WPM = 24 seconds
    expect(minDwellMs(100)).toBeCloseTo(24000, -2);
  });

  it("minDwellMs caps at 30s", () => {
    expect(minDwellMs(10000)).toBe(30000);
  });
});
