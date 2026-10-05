/** Capture without CDP clipping, which temporarily resizes Chrome's rendered view. */
export async function captureViewportScreenshot(capture, viewport, options = {}) {
  const { format = "jpeg", quality = 82, maxLongEdge, region } = options;
  const shot = await capture({
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  });
  const bytes = Uint8Array.from(atob(shot.data), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  try {
    const pixelScaleX = bitmap.width / viewport.surfaceWidth;
    const pixelScaleY = bitmap.height / viewport.surfaceHeight;
    const source = region || { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const sourceWidth = source.width * pixelScaleX;
    const sourceHeight = source.height * pixelScaleY;
    const scale = maxLongEdge ? Math.min(1, maxLongEdge / Math.max(sourceWidth, sourceHeight)) : 1;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(
      bitmap,
      source.x * pixelScaleX, source.y * pixelScaleY, sourceWidth, sourceHeight,
      0, 0, width, height,
    );
    const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: quality / 100 });
    const encoded = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < encoded.length; i += 8192) {
      binary += String.fromCharCode(...encoded.subarray(i, i + 8192));
    }
    return { data: btoa(binary), width, height, scale: width / source.width };
  } finally {
    bitmap.close();
  }
}
