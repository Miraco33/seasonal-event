import type { Page } from "playwright";
import { rasterDimensions } from "./image-ocr.js";

const maxPixels = 8_000_000;

// These maps use white coordinate lettering with a red outline. The outline
// locates the text; recognizing the outline itself merges neighboring glyphs.
export async function prepareCoordinateImages(page: Page, bytes: Buffer): Promise<{
  line: Buffer; x: Buffer; y: Buffer;
} | undefined> {
  if (bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new Error("coordinate image exceeds the 10 MiB bound");
  }
  const dimensions = rasterDimensions(bytes);
  if (!dimensions || dimensions.width * dimensions.height > maxPixels) {
    throw new Error("coordinate image has invalid dimensions or exceeds 8 megapixels");
  }
  const mime = bytes[0] === 137 ? "image/png" : "image/jpeg";
  const prepared = await page.evaluate(async ({ source, expected, limit }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width !== expected.width || height !== expected.height || width * height > limit) {
      throw new Error("decoded coordinate image dimensions do not match its bounded header");
    }
    function canvas(width: number, height: number): HTMLCanvasElement {
      if (width <= 0 || height <= 0 || width * height > limit) {
        throw new Error("derived coordinate image exceeds 8 megapixels");
      }
      const result = document.createElement("canvas");
      result.width = width;
      result.height = height;
      return result;
    }
    function context(element: HTMLCanvasElement): CanvasRenderingContext2D {
      const result = element.getContext("2d");
      if (!result) throw new Error("coordinate image canvas is unavailable");
      result.fillStyle = "#fff";
      result.fillRect(0, 0, element.width, element.height);
      return result;
    }
    const original = canvas(width, height);
    const originalContext = context(original);
    originalContext.drawImage(image, 0, 0);
    const pixels = originalContext.getImageData(0, 0, width, height);
    const data = pixels.data;
    const red = new Uint8Array(width * height);
    const redRows = new Uint32Array(height);
    const stride = width + 1;
    const integral = new Uint32Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        const offset = index * 4;
        const r = data[offset]; const g = data[offset + 1]; const b = data[offset + 2];
        // Bright saturated outlines exclude the brown ink of the map itself.
        const ink = r > 180 && r > g * 1.7 && r > b * 1.5 ? 1 : 0;
        red[index] = ink;
        redRows[y] += ink;
        sum += ink;
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum;
      }
    }
    const distance = Math.max(4, Math.round(width * 0.01));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const left = Math.max(0, x - distance); const right = Math.min(width, x + distance + 1);
        const top = Math.max(0, y - distance); const bottom = Math.min(height, y + distance + 1);
        const nearby = integral[bottom * stride + right] - integral[top * stride + right]
          - integral[bottom * stride + left] + integral[top * stride + left];
        const ink = data[offset] > 200 && data[offset + 1] > 200 && data[offset + 2] > 200 && nearby > 0;
        data[offset] = data[offset + 1] = data[offset + 2] = ink ? 0 : 255;
        data[offset + 3] = 255;
      }
    }
    originalContext.putImageData(pixels, 0, 0);

    // Ignore the top banner and bottom portrait when locating the coordinate
    // strip. These fractions describe the map template, not any event value.
    const band = Math.max(8, Math.round(height * 0.015));
    const firstRow = Math.floor(height * 0.2);
    const lastRow = Math.floor(height * 0.65) - band;
    if (firstRow >= lastRow) return undefined;
    let score = 0;
    for (let row = firstRow; row < firstRow + band; row++) score += redRows[row];
    let bestY = -1; let bestScore = 0;
    for (let y = firstRow; y < lastRow; y++) {
      if (score > bestScore) { bestScore = score; bestY = y + Math.floor(band / 2); }
      score += redRows[y + band] - redRows[y];
    }
    if (bestY < 0) return undefined;
    const radius = Math.max(32, Math.round(height * 0.08));
    const stripTop = Math.max(0, bestY - radius); const stripBottom = Math.min(height, bestY + radius);
    let stripLeft = width; let stripRight = 0;
    for (let y = stripTop; y < stripBottom; y++) {
      for (let x = 0; x < width; x++) {
        if (red[y * width + x]) { stripLeft = Math.min(stripLeft, x); stripRight = Math.max(stripRight, x); }
      }
    }
    if (stripLeft >= stripRight) return undefined;
    stripLeft = Math.max(0, stripLeft - 8); stripRight = Math.min(width, stripRight + 9);
    const padding = 16;
    const strip = canvas((stripRight - stripLeft) * 2 + padding * 2, (stripBottom - stripTop) * 2 + padding * 2);
    const stripContext = context(strip);
    stripContext.imageSmoothingEnabled = false;
    stripContext.drawImage(original, stripLeft, stripTop, stripRight - stripLeft, stripBottom - stripTop,
      padding, padding, strip.width - padding * 2, strip.height - padding * 2);
    const stripPixels = stripContext.getImageData(0, 0, strip.width, strip.height).data;
    const blackRows = new Uint32Array(strip.height);
    for (let y = padding; y < strip.height - padding; y++) {
      for (let x = padding; x < strip.width - padding; x++) {
        if (stripPixels[(y * strip.width + x) * 4] < 128) blackRows[y]++;
      }
    }
    let peak = padding;
    for (let y = padding; y < strip.height - padding; y++) if (blackRows[y] > blackRows[peak]) peak = y;
    if (!blackRows[peak]) return undefined;
    const rowThreshold = Math.max(4, blackRows[peak] * 0.08);
    let textTop = peak; let textBottom = peak;
    while (textTop > padding && blackRows[textTop - 1] >= rowThreshold) textTop--;
    while (textBottom < strip.height - padding && blackRows[textBottom + 1] >= rowThreshold) textBottom++;
    let textLeft = strip.width; let textRight = 0;
    for (let y = textTop; y <= textBottom; y++) {
      for (let x = padding; x < strip.width - padding; x++) {
        if (stripPixels[(y * strip.width + x) * 4] < 128) {
          textLeft = Math.min(textLeft, x); textRight = Math.max(textRight, x);
        }
      }
    }
    if (textLeft >= textRight) return undefined;
    const text = canvas(textRight - textLeft + 1 + padding * 2, textBottom - textTop + 1 + padding * 2);
    const textContext = context(text);
    textContext.drawImage(strip, textLeft, textTop, textRight - textLeft + 1, textBottom - textTop + 1,
      padding, padding, text.width - padding * 2, text.height - padding * 2);
    const textPixels = textContext.getImageData(0, 0, text.width, text.height).data;
    const seen = new Uint8Array(text.width * text.height);
    const queue = new Int32Array(text.width * text.height);
    const glyphHeight = text.height - padding * 2;
    let left = text.width; let right = 0; let top = text.height; let bottom = 0;
    for (let index = 0; index < seen.length; index++) {
      if (seen[index] || textPixels[index * 4] > 128) continue;
      let head = 0; let tail = 1;
      queue[0] = index; seen[index] = 1;
      let componentLeft = index % text.width; let componentRight = componentLeft;
      let componentTop = Math.floor(index / text.width); let componentBottom = componentTop; let area = 0;
      const enqueue = (neighbor: number) => {
        if (!seen[neighbor] && textPixels[neighbor * 4] < 128) { seen[neighbor] = 1; queue[tail++] = neighbor; }
      };
      while (head < tail) {
        const current = queue[head++]; const x = current % text.width; const y = Math.floor(current / text.width);
        componentLeft = Math.min(componentLeft, x); componentRight = Math.max(componentRight, x);
        componentTop = Math.min(componentTop, y); componentBottom = Math.max(componentBottom, y); area++;
        if (x > 0) enqueue(current - 1);
        if (x + 1 < text.width) enqueue(current + 1);
        if (y > 0) enqueue(current - text.width);
        if (y + 1 < text.height) enqueue(current + text.width);
      }
      const componentWidth = componentRight - componentLeft + 1;
      const componentHeight = componentBottom - componentTop + 1;
      // Thin map borders and curved ornaments can span the same row as text.
      if (componentHeight >= glyphHeight * 0.45 && componentWidth >= glyphHeight * 0.1
        && componentWidth <= glyphHeight * 2 && area / (componentWidth * componentHeight) >= 0.4) {
        left = Math.min(left, componentLeft); right = Math.max(right, componentRight);
        top = Math.min(top, componentTop); bottom = Math.max(bottom, componentBottom);
      }
    }
    if (left >= right || top >= bottom) return undefined;
    const columns = new Uint16Array(right - left + 1);
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) if (textPixels[(y * text.width + x) * 4] < 128) columns[x - left]++;
    }
    let gap: { start: number; end: number; width: number } | undefined;
    for (let x = 0; x < columns.length;) {
      if (columns[x]) { x++; continue; }
      const start = x;
      while (x < columns.length && !columns[x]) x++;
      const midpoint = (start + x) / 2;
      if (midpoint > columns.length * 0.25 && midpoint < columns.length * 0.75 && (!gap || x - start > gap.width)) {
        gap = { start, end: x, width: x - start };
      }
    }
    if (!gap) return undefined;
    const split = left + Math.floor((gap.start + gap.end) / 2);
    const crop = (start: number, end: number): string => {
      const result = canvas(end - start + 1 + padding * 2, bottom - top + 1 + padding * 2);
      context(result).drawImage(text, start, top, end - start + 1, bottom - top + 1,
        padding, padding, result.width - padding * 2, result.height - padding * 2);
      return result.toDataURL("image/png");
    };
    return { line: crop(left, right), x: crop(left, split), y: crop(split + 1, right) };
  }, { source: "data:" + mime + ";base64," + bytes.toString("base64"), expected: dimensions, limit: maxPixels });
  if (!prepared) return undefined;
  return {
    line: Buffer.from(prepared.line.split(",")[1], "base64"),
    x: Buffer.from(prepared.x.split(",")[1], "base64"),
    y: Buffer.from(prepared.y.split(",")[1], "base64"),
  };
}
