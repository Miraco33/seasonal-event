import type { Page } from "playwright";
import { recognizeImage, recognizeCoordinateCrop, trustedImageUrl, type OcrLine, type OcrResult } from "./image-ocr.js";
import { prepareCoordinateImages } from "./coordinate-images.js";

export interface TaskImageEvidence { text: string; imageUrls: string[]; lines: OcrLine[] }
export type ImageReader = (bytes: Buffer) => Promise<OcrResult>;

export async function taskImageUrls(page: Page, questName: string | null): Promise<string[]> {
  return page.locator(".quest, .fgs__howto__box, .content__event-info").evaluateAll((blocks, target) => {
    if (!target) return [];
    const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    for (const block of blocks) {
      const headingScope = block.matches(".fgs__howto__box") ? block.closest("li") : block;
      const headings = Array.from(headingScope?.querySelectorAll("h2,h3,h4") || []);
      if (!headings.some(heading => normalize(heading.textContent?.trim() || heading.querySelector("img")?.getAttribute("alt")?.trim() || "") === normalize(target))) continue;
      const images = Array.from(block.querySelectorAll(block.matches(".content__event-info") ? ".content__event-info__area > img" : "img"));
      // The standard seasonal template puts its map next to .quest, in the
      // same overview container. Do not search all maps elsewhere on the page.
      if (block.matches(".quest")) images.push(...Array.from(block.parentElement?.querySelectorAll(":scope > .map img") ?? []));
      return [...new Set(images.filter(image => !image.closest("h1,h2,h3,h4,h5,h6") &&
        (((image as HTMLImageElement).naturalWidth || Number(image.getAttribute("width"))) >= 250 || image.getAttribute("loading") === "lazy") &&
        (((image as HTMLImageElement).naturalHeight || Number(image.getAttribute("height"))) >= 180 || image.getAttribute("loading") === "lazy") &&
        (image as HTMLImageElement).naturalWidth * (image as HTMLImageElement).naturalHeight <= 8_000_000)
        .map(image => (image as HTMLImageElement).currentSrc || image.getAttribute("src") || ""))].slice(0, 4);
    }
    return [];
  }, questName);
}

export async function readTaskImages(page: Page, questName: string | null, reader: ImageReader = recognizeImage): Promise<TaskImageEvidence> {
  const imageUrls = (await taskImageUrls(page, questName)).filter(trustedImageUrl);
  const lines: OcrLine[] = [];
  for (const url of imageUrls) {
    const response = await page.context().request.get(url, { timeout: 15000, maxRedirects: 0 });
    try {
      if (!response.ok() || !trustedImageUrl(response.url())) throw new Error(`unable to load official task image: HTTP ${response.status()}`);
      if (!/^image\/(png|jpeg)(?:;|$)/i.test(response.headers()["content-type"] ?? "")) throw new Error("task image returned an unsupported media type");
      const statedLength = Number(response.headers()["content-length"] ?? 0);
      if (statedLength > 10 * 1024 * 1024) throw new Error("task image exceeds 10 MiB");
      const bytes = await response.body();
      if (bytes.length > 10 * 1024 * 1024) throw new Error("task image exceeds 10 MiB");
      lines.push(...(await reader(bytes)).lines);
      if (reader === recognizeImage) {
        const coordinateImages = await prepareCoordinateImages(page, bytes);
        if (coordinateImages) {
          const whole = await recognizeCoordinateCrop(coordinateImages.line, true);
          const x = await recognizeCoordinateCrop(coordinateImages.x, true);
          const y = await recognizeCoordinateCrop(coordinateImages.y, true);
          const combined = consistentCoordinateLine(whole, x, y);
          if (combined) lines.push(combined);
        }
      }
    } finally { await response.dispose(); }
  }
  return { imageUrls, lines, text: lines.filter(line => line.confidence >= 50).map(line => line.text).join("\n") };
}

// Whole-line and separately segmented axes must agree character-for-character.
// Keep the actual axis confidence values; never repair a digit from game data.
export function consistentCoordinateLine(whole: OcrLine[], x: OcrLine[], y: OcrLine[]): OcrLine | undefined {
  if (whole.length !== 1 || x.length !== 1 || y.length !== 1) return undefined;
  const compact = (text: string) => text.normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  const xText = compact(x[0].text); const yText = compact(y[0].text);
  if (!/^X:\d{1,2}(?:\.\d)?$/.test(xText) || !/^Y:\d{1,2}(?:\.\d)?$/.test(yText) || compact(whole[0].text) !== xText + yText) return undefined;
  return { text: `${xText} ${yText}`, confidence: (x[0].confidence + y[0].confidence) / 2,
    words: [...x[0].words, ...y[0].words] };
}
