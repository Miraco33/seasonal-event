import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface OcrWord { text: string; confidence: number; left: number; top: number; width: number; height: number }
export interface OcrLine { text: string; confidence: number; words: OcrWord[] }
export interface OcrResult { lines: OcrLine[]; engine: "tesseract"; sha256: string }
export interface ImageCoordinates { x: number; y: number; confidence: number }

const results = new Map<string, Promise<OcrResult>>();
const maxImageBytes = 10 * 1024 * 1024;

export function ocrExecutable(): string {
  const configured = process.env.OCR_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  const installed = "C:/Program Files/Tesseract-OCR/tesseract.exe";
  return process.platform === "win32" && existsSync(installed) ? installed : "tesseract";
}

export function parseTsv(tsv: string): OcrLine[] {
  const groups = new Map<string, OcrWord[]>();
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const columns = row.split("\t");
    if (columns.length < 12 || columns[0] !== "5") continue;
    const confidence = Number(columns[10]);
    const word: OcrWord = { text: columns.slice(11).join("\t").trim(), confidence,
      left: Number(columns[6]), top: Number(columns[7]), width: Number(columns[8]), height: Number(columns[9]) };
    if (!word.text || !Number.isFinite(confidence) || confidence < 0 || confidence > 100 ||
        [word.left, word.top, word.width, word.height].some(value => !Number.isFinite(value) || value < 0)) continue;
    const key = columns.slice(1, 5).join(":");
    const words = groups.get(key) ?? [];
    words.push(word);
    groups.set(key, words);
  }
  return [...groups.values()].map(words => ({ words, text: words.map(word => word.text).join(" "),
    confidence: words.reduce((sum, word) => sum + word.confidence, 0) / words.length }));
}

// Coordinates require both axes, an explicit separator and a confidence floor.
// Never insert a missing decimal point or turn a guessed digit into a map flag.
export function imageCoordinates(lines: OcrLine[]): ImageCoordinates[] {
  const found = new Map<string, ImageCoordinates>();
  for (const line of lines) {
    const compact = line.text.normalize("NFKC").replace(/\s+/g, "");
    if (line.confidence < 60) continue;
    for (const match of compact.matchAll(/X[:：](\d{1,2}(?:\.\d)?)\s*[,，、]?Y[:：](\d{1,2}(?:\.\d)?)(?![\d.])/gi)) {
      const x = Number(match[1]); const y = Number(match[2]);
      if (x < 1 || y < 1 || x > 50 || y > 50) continue;
      found.set(`${x}:${y}`, { x, y, confidence: line.confidence });
    }
  }
  return [...found.values()];
}

export function trustedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["static.web.sdo.com", "actff1.web.sdo.com"].includes(url.hostname) &&
      /\.(?:png|jpe?g)(?:$)/i.test(url.pathname);
  } catch { return false; }
}

export async function recognizeImage(bytes: Buffer): Promise<OcrResult> {
  if (bytes.length === 0 || bytes.length > maxImageBytes) throw new Error("OCR image exceeds the 10 MiB bound");
  const dimensions = rasterDimensions(bytes);
  if (!dimensions || dimensions.width * dimensions.height > 8_000_000) throw new Error("OCR image has invalid dimensions or exceeds 8 megapixels");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = `${ocrExecutable()}:${process.env.OCR_TESSDATA_DIR ?? ""}:${sha256}`;
  let pending = results.get(key);
  if (!pending) {
    pending = runOcr(bytes, sha256);
    results.set(key, pending);
    if (results.size > 64) results.delete(results.keys().next().value!);
    pending.catch(() => results.delete(key));
  }
  return pending;
}

async function runOcr(bytes: Buffer, sha256: string): Promise<OcrResult> {
  const cache = process.env.OCR_CACHE_DIR?.trim();
  const cachedPath = cache ? join(resolve(cache), `${sha256}.tesseract-chi-sim-eng-v1.json`) : undefined;
  if (cachedPath) {
    try {
      const cached = JSON.parse(await readFile(cachedPath, "utf8")) as OcrResult;
      if (cached.engine === "tesseract" && cached.sha256 === sha256 && Array.isArray(cached.lines) &&
          cached.lines.every(line => typeof line.text === "string" && Number.isFinite(line.confidence) && Array.isArray(line.words))) return cached;
      throw new Error("invalid OCR cache document");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        console.warn(JSON.stringify({ type: "seasonal-event-collector-diagnostic", level: "warning", code: "ocr_cache_invalid",
          message: error instanceof Error ? error.message : String(error) }));
        await rm(cachedPath, { force: true });
      }
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "seasonal-image-ocr-"));
  try {
    const input = join(directory, "image.png");
    await writeFile(input, bytes);
    const chinese = await execute([input, "stdout", "-l", "chi_sim+eng", "--psm", "11", "tsv"]);
    const english = await execute([input, "stdout", "-l", "eng", "--psm", "11", "tsv"]);
    const result: OcrResult = { sha256, engine: "tesseract", lines: [...parseTsv(chinese), ...parseTsv(english)] };
    if (cachedPath) {
      await mkdir(resolve(cache!), { recursive: true });
      const serialized = `${JSON.stringify(result)}\n`;
      if (Buffer.byteLength(serialized) <= 2 * 1024 * 1024) {
        await pruneOcrCache(resolve(cache!));
        await writeFile(cachedPath, serialized, "utf8");
      }
    }
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function pruneOcrCache(directory: string): Promise<void> {
  const files = await Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.tesseract-chi-sim-eng-v1\.json$/.test(name))
    .map(async name => ({ path: join(directory, name), info: await stat(join(directory, name)) })));
  files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
  let bytes = 0;
  for (let index = 0; index < files.length; index++) {
    bytes += files[index].info.size;
    if (index >= 31 || bytes > 30 * 1024 * 1024) await rm(files[index].path, { force: true });
  }
}

export function rasterDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return undefined;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) return undefined;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return undefined;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) {
        const height = bytes.readUInt16BE(offset + 3); const width = bytes.readUInt16BE(offset + 5);
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      offset += length;
    }
  }
  return undefined;
}

function execute(args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const tessdata = process.env.OCR_TESSDATA_DIR?.trim();
    const configuredArgs = tessdata ? ["--tessdata-dir", resolve(tessdata), ...args] : args;
    execFile(ocrExecutable(), configuredArgs, { timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, OMP_THREAD_LIMIT: "1" }, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error || /Failed loading language|Error opening data file|couldn't load any languages/i.test(stderr)) {
        reject(new Error(`image OCR unavailable or failed: ${error?.message ?? "required language model cannot load"}; ${stderr.slice(0, 500)}`, { cause: error }));
      }
      else resolveResult(stdout);
    });
  });
}

export async function recognizeCoordinateCrop(bytes: Buffer, whitelist = false): Promise<OcrLine[]> {
  const dimensions = rasterDimensions(bytes);
  if (bytes.length === 0 || bytes.length > maxImageBytes || !dimensions || dimensions.width * dimensions.height > 8_000_000) {
    throw new Error("coordinate OCR image exceeds byte/pixel bounds");
  }
  const directory = await mkdtemp(join(tmpdir(), "seasonal-coordinate-ocr-"));
  try {
    const input = join(directory, "coordinate.png"); await writeFile(input, bytes);
    const args = [input, "stdout", "-l", "eng", "--psm", "7", "--oem", "1",
      "-c", "load_system_dawg=0", "-c", "load_freq_dawg=0"];
    if (whitelist) args.push("-c", "tessedit_char_whitelist=XYxy:0123456789.");
    args.push("tsv");
    return parseTsv(await execute(args));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
