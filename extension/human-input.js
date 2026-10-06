// human-input.js — Pure math helpers for humanized input simulation.
// No CDP calls, no Chrome APIs — just timing and geometry so it's unit-testable.

// ── Random helpers ──────────────────────────────────────────────────────────

export function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function gaussianRandom(mean, stddev) {
  const u1 = Math.random();
  const u2 = Math.random();
  return mean + stddev * Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
}

// ── Keyboard timing ─────────────────────────────────────────────────────────

/** Time (ms) a key is held down between rawKeyDown and keyUp. */
export function keyHoldMs() {
  return Math.max(40, gaussianRandom(90, 12));
}

/** Time (ms) between characters while typing. */
export function charFlightMs() {
  return randomBetween(55, 140);
}

/** Extra pause (ms) at word boundaries (after space). */
export function wordPauseMs() {
  return randomBetween(120, 300);
}

/** Shortcut hold time (ms) — shorter than typing. */
export function shortcutHoldMs() {
  return randomBetween(25, 55);
}

// ── Mouse: Bézier path generation ───────────────────────────────────────────

/**
 * Generate an organic, human-like Bézier path from `start` to `end`.
 * Mimics human arm/wrist pivot arcs, asymmetrical curvature, and Fitts' law deceleration.
 * Returns an array of {x, y} points including start and end.
 */
export function bezierPath(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 5) return [start, end];

  // Step count scales with distance: 10 to 30 steps
  const steps = Math.min(30, Math.max(10, Math.floor(dist / 25)));
  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;

  // Decide arc curvature direction: right-handed human wrist pivot arcs naturally
  // Bias curve direction based on movement quadrant with natural randomness
  const arcBias = (dx * dy >= 0 ? 1 : -1) * (Math.random() < 0.8 ? 1 : -1);
  const curvatureMagnitude = (0.15 + Math.random() * 0.25) * dist * arcBias;

  // Two control points creating an asymmetric, organic curve (Fitts' Law trajectory)
  const t1 = 0.2 + Math.random() * 0.15;
  const t2 = 0.65 + Math.random() * 0.15;
  const cp1 = {
    x: start.x + dx * t1 + perpX * curvatureMagnitude * (0.8 + Math.random() * 0.4),
    y: start.y + dy * t1 + perpY * curvatureMagnitude * (0.8 + Math.random() * 0.4),
  };
  const cp2 = {
    x: start.x + dx * t2 + perpX * curvatureMagnitude * (0.4 + Math.random() * 0.4),
    y: start.y + dy * t2 + perpY * curvatureMagnitude * (0.4 + Math.random() * 0.4),
  };

  const path = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    path.push({
      x: Math.round(u * u * u * start.x + 3 * u * u * t * cp1.x + 3 * u * t * t * cp2.x + t * t * t * end.x),
      y: Math.round(u * u * u * start.y + 3 * u * u * t * cp1.y + 3 * u * t * t * cp2.y + t * t * t * end.y),
    });
  }

  // Organic micro-tremor: tiny involuntary hand noise, strongest in mid-flight, zero at ends
  for (let i = 1; i < path.length - 1; i++) {
    const envelope = Math.sin((i / path.length) * Math.PI);
    const wobbleX = envelope * (Math.random() - 0.5) * Math.min(3.5, dist * 0.02);
    const wobbleY = envelope * (Math.random() - 0.5) * Math.min(3.5, dist * 0.02);
    path[i].x += Math.round(wobbleX);
    path[i].y += Math.round(wobbleY);
  }

  // Ensure first and last points are exact
  path[0] = { x: Math.round(start.x), y: Math.round(start.y) };
  path[path.length - 1] = { x: Math.round(end.x), y: Math.round(end.y) };

  return path;
}

/**
 * Calculate a natural human click point on a target element bounding rectangle.
 * Rather than clicking the exact center (a known bot indicator), humans click
 * with a realistic 2D Gaussian distribution across the inner safe area of the element.
 */
export function humanClickPoint(rect) {
  const w = rect.width || 10;
  const h = rect.height || 10;
  const left = rect.left !== undefined ? rect.left : (rect.x - w / 2);
  const top = rect.top !== undefined ? rect.top : (rect.y - h / 2);

  // Safe inner margin (at least 3px, or 10% of dimension)
  const marginX = Math.min(12, Math.max(3, w * 0.12));
  const marginY = Math.min(8, Math.max(3, h * 0.15));

  const safeW = Math.max(2, w - 2 * marginX);
  const safeH = Math.max(2, h - 2 * marginY);

  // Horizontal: For wider buttons or text labels, people tend to click slightly left of center
  // (where reading starts) with a natural standard deviation
  const horizontalBias = w > 80 ? 0.42 : 0.5;
  const targetRelX = gaussianRandom(safeW * horizontalBias, safeW * 0.18);
  const clampedX = Math.max(0, Math.min(safeW, targetRelX));

  // Vertical: Centered with Gaussian distribution
  const targetRelY = gaussianRandom(safeH * 0.5, safeH * 0.2);
  const clampedY = Math.max(0, Math.min(safeH, targetRelY));

  return {
    x: Math.round(left + marginX + clampedX),
    y: Math.round(top + marginY + clampedY),
  };
}

/**
 * Return a natural human resting point within the viewport.
 * Used when initial mouse position is unknown, so cursor never unnaturally sweeps from (0,0).
 */
export function naturalRestingPoint(viewportWidth, viewportHeight) {
  const vw = viewportWidth || 1280;
  const vh = viewportHeight || 720;
  // Natural resting area: central 50% horizontally, middle-to-lower 50% vertically
  return {
    x: Math.round(vw * randomBetween(0.28, 0.72)),
    y: Math.round(vh * randomBetween(0.38, 0.78)),
  };
}

/**
 * Per-step delay array with ease-in/ease-out for a mouse path.
 * Returns array of delays in ms (length = pathLength - 1).
 */
export function stepTimings(pathLength) {
  const timings = [];
  for (let i = 0; i < pathLength - 1; i++) {
    const t = pathLength > 2 ? i / (pathLength - 2) : 0.5;
    // Slower at start/end, faster in middle
    const speed = 0.3 + 0.7 * (1 - Math.abs(2 * t - 1));
    timings.push(randomBetween(8, 22) / Math.max(0.3, speed));
  }
  return timings;
}

// ── Mouse: click timing ─────────────────────────────────────────────────────

/** Hover delay before pressing (ms). */
export function preClickDelayMs() {
  return randomBetween(35, 80);
}

/** Hold between mousePressed and mouseReleased (ms). */
export function clickHoldMs() {
  return randomBetween(50, 95);
}

/** Small px offset between press and release coords. */
export function clickJitter() {
  return {
    dx: Math.round((Math.random() - 0.5) * 3),
    dy: Math.round((Math.random() - 0.5) * 3),
  };
}

// ── Scroll chunking ─────────────────────────────────────────────────────────

/**
 * Break a scroll delta into human-like chunks.
 * Returns array of { dx, dy } deltas.
 */
export function scrollChunks(deltaX, deltaY) {
  const magnitude = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  if (magnitude === 0) return [{ dx: 0, dy: 0 }];
  const chunkSize = randomBetween(40, 120);
  const steps = Math.max(1, Math.ceil(magnitude / chunkSize));
  const chunks = [];
  for (let i = 0; i < steps; i++) {
    chunks.push({ dx: deltaX / steps, dy: deltaY / steps });
  }
  return chunks;
}

/** Delay between scroll chunks (ms). */
export function scrollStepDelayMs() {
  return randomBetween(12, 30);
}

// ── Pacing ──────────────────────────────────────────────────────────────────

/** Count words in a text string. */
export function wordCount(text) {
  if (!text) return 0;
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.split(" ").length : 0;
}

/**
 * Minimum dwell time (ms) for a given word count at 250 WPM reading speed.
 * Clamped to [800ms, 30s].
 */
export function minDwellMs(words) {
  if (words <= 0) return 0;
  const raw = (words / 250) * 60_000;
  return Math.min(30_000, Math.max(800, raw));
}
