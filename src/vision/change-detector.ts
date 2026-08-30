import { PNG } from "pngjs";
import { NormalizedRegion } from "./types.js";

export interface VisualChange {
  /** Whether any visual difference was detected */
  hasChanged: boolean;
  /** Fraction of the screen that changed (0.0 to 1.0) */
  changedRatio: number;
  /** Number of modified tiles */
  changedTileCount: number;
  /** Total number of comparison tiles */
  totalTiles: number;
  /** Suggested high-detail inspection region if change is localized (normalized 0-1000 coords) */
  region?: NormalizedRegion;
}

export interface ChangeDetectorOptions {
  /** Number of horizontal grid columns (default: 10) */
  gridCols?: number;
  /** Number of vertical grid rows (default: 10) */
  gridRows?: number;
  /** Luminance difference threshold per tile (0-255, default: 5) */
  diffThreshold?: number;
}

/**
 * Fast, dependency-free local visual change detector.
 * Compares coarse tile luminance grids between frames to identify localized visual mutations
 * (such as open dropdowns, modals, focus highlights, or updated form regions).
 */
export class VisualChangeDetector {
  private gridCols: number;
  private gridRows: number;
  private diffThreshold: number;

  constructor(options: ChangeDetectorOptions = {}) {
    this.gridCols = options.gridCols ?? 10;
    this.gridRows = options.gridRows ?? 10;
    this.diffThreshold = options.diffThreshold ?? 5;
  }

  /**
   * Compare two base64 screenshot frames and return change statistics and localized changed bounding box.
   */
  public compare(previousBase64: string, currentBase64: string): VisualChange {
    const totalTiles = this.gridCols * this.gridRows;

    if (!previousBase64 || !currentBase64) {
      return {
        hasChanged: true,
        changedRatio: 1.0,
        changedTileCount: totalTiles,
        totalTiles,
      };
    }

    if (previousBase64 === currentBase64) {
      return {
        hasChanged: false,
        changedRatio: 0.0,
        changedTileCount: 0,
        totalTiles,
      };
    }

    const prevTiles = this.computeTileGrid(previousBase64);
    const currTiles = this.computeTileGrid(currentBase64);

    if (!prevTiles || !currTiles) {
      // Fallback if not decodable as 2D spatial grid: binary difference
      return {
        hasChanged: true,
        changedRatio: 1.0,
        changedTileCount: totalTiles,
        totalTiles,
      };
    }

    let changedTileCount = 0;
    let minRow = this.gridRows;
    let maxRow = -1;
    let minCol = this.gridCols;
    let maxCol = -1;

    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        const idx = r * this.gridCols + c;
        const diff = Math.abs(prevTiles[idx] - currTiles[idx]);

        if (diff >= this.diffThreshold) {
          changedTileCount++;
          if (r < minRow) minRow = r;
          if (r > maxRow) maxRow = r;
          if (c < minCol) minCol = c;
          if (c > maxCol) maxCol = c;
        }
      }
    }

    const changedRatio = Number((changedTileCount / totalTiles).toFixed(4));
    const hasChanged = changedTileCount > 0;

    let region: NormalizedRegion | undefined;
    // Suggest localized region only if changes occupy between 1% and 50% of the screen
    if (hasChanged && changedRatio <= 0.5 && minRow <= maxRow && minCol <= maxCol) {
      const x = Math.round((minCol / this.gridCols) * 1000);
      const y = Math.round((minRow / this.gridRows) * 1000);
      const width = Math.min(1000 - x, Math.round(((maxCol - minCol + 1) / this.gridCols) * 1000));
      const height = Math.min(1000 - y, Math.round(((maxRow - minRow + 1) / this.gridRows) * 1000));

      region = { x, y, width, height };
    }

    return {
      hasChanged,
      changedRatio,
      changedTileCount,
      totalTiles,
      region,
    };
  }

  /**
   * Extract 2D spatial grid tile average luminance (0-255) from PNG image payload
   */
  private computeTileGrid(base64: string): Uint8Array | null {
    try {
      const buf = Buffer.from(base64, "base64");
      // Check for PNG signature 0x89 0x50 0x4E 0x47
      if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
        return null;
      }

      const png = PNG.sync.read(buf);
      const width = png.width;
      const height = png.height;
      const data = png.data;

      const totalTiles = this.gridCols * this.gridRows;
      const grid = new Uint8Array(totalTiles);

      const tileW = width / this.gridCols;
      const tileH = height / this.gridRows;

      for (let r = 0; r < this.gridRows; r++) {
        const startY = Math.floor(r * tileH);
        const endY = Math.floor((r + 1) * tileH);

        for (let c = 0; c < this.gridCols; c++) {
          const startX = Math.floor(c * tileW);
          const endX = Math.floor((c + 1) * tileW);

          let sumLum = 0;
          let count = 0;

          // Sample every 4th pixel horizontally and vertically
          for (let y = startY; y < endY; y += 4) {
            for (let x = startX; x < endX; x += 4) {
              const idx = (y * width + x) << 2;
              const rVal = data[idx];
              const gVal = data[idx + 1];
              const bVal = data[idx + 2];
              // Standard perceptual luminance: 0.299 R + 0.587 G + 0.114 B
              const lum = (rVal * 77 + gVal * 150 + bVal * 29) >> 8;
              sumLum += lum;
              count++;
            }
          }

          const tileIdx = r * this.gridCols + c;
          grid[tileIdx] = count > 0 ? Math.round(sumLum / count) : 0;
        }
      }

      return grid;
    } catch {
      return null;
    }
  }
}
