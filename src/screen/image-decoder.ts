export interface ImageDimensions {
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp" | "unknown";
}

/**
 * Decode image dimensions directly from binary header without re-encoding
 */
export function decodeImageDimensions(buffer: Buffer): ImageDimensions {
  if (buffer.length < 24) {
    throw new Error("Buffer too short to determine image dimensions");
  }

  // 1. PNG check: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { width, height, format: "png" };
  }

  // 2. JPEG check: FF D8
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0, SOF1, SOF2 (Baseline, Extended, Progressive)
      if (marker >= 0xc0 && marker <= 0xc3 && marker !== 0xc4) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height, format: "jpeg" };
      }
      const length = buffer.readUInt16BE(offset + 2);
      offset += 2 + length;
    }
    return { width: 0, height: 0, format: "jpeg" };
  }

  // 3. WebP check: RIFF .... WEBP
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const type = buffer.toString("ascii", 12, 16);
    if (type === "VP8 ") {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return { width, height, format: "webp" };
    } else if (type === "VP8L") {
      const b1 = buffer[21];
      const b2 = buffer[22];
      const b3 = buffer[23];
      const b4 = buffer[24];
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { width, height, format: "webp" };
    } else if (type === "VP8X") {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height, format: "webp" };
    }
  }

  return { width: 0, height: 0, format: "unknown" };
}
