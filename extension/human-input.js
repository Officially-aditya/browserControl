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
 * Generate a cubic Bézier path from `start` to `end`.
 * Returns an array of {x, y} points including start and end.
 */
export function bezierPath(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 5) return [start, end];

  const steps = Math.min(25, Math.max(8, Math.floor(dist / 30)));
  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ? dx / dist : 0;

  // Two random control points offset perpendicular to the straight line
  const cp1 = {
    x: start.x + dx * (0.25 + Math.random() * 0.15) + perpX * (Math.random() - 0.5) * dist * 0.3,
    y: start.y + dy * (0.25 + Math.random() * 0.15) + perpY * (Math.random() - 0.5) * dist * 0.3,
  };
  const cp2 = {
    x: start.x + dx * (0.60 + Math.random() * 0.15) + perpX * (Math.random() - 0.5) * dist * 0.2,
    y: start.y + dy * (0.60 + Math.random() * 0.15) + perpY * (Math.random() - 0.5) * dist * 0.2,
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

  // Micro-wobble (hand tremor): strongest mid-path, zero at endpoints
  for (let i = 1; i < path.length - 1; i++) {
    const wobble = Math.sin((i / path.length) * Math.PI) * (Math.random() - 0.5) * Math.min(4, dist * 0.02);
    path[i].x += Math.round(wobble * perpX);
    path[i].y += Math.round(wobble * perpY);
  }

  return path;
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
