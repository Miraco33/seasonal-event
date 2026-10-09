import assert from "node:assert/strict";
import test from "node:test";
import { imageCoordinates, parseTsv, rasterDimensions, recognizeImage, trustedImageUrl, type OcrLine } from "./image-ocr.js";
import { consistentCoordinateLine } from "./task-images.js";

const line = (text: string, confidence = 95): OcrLine => ({ text, confidence, words: [] });
test("coordinates handle spacing and full-width labels without guessing missing decimals or axes", () => {
  assert.deepEqual(imageCoordinates([line("Ｘ：8 . 5 Ｙ：9 . 7")]).map(({ x, y }) => [x, y]), [[8.5, 9.7]]);
  for (const text of ["X:85 Y:97", "X:8.5", "8.5 9.7", "X:8..5 Y:9.7", "X:8.55 Y:9.7", "X:0.5 Y:9.7"]) {
    assert.deepEqual(imageCoordinates([line(text)]), [], text);
  }
  assert.deepEqual(imageCoordinates([line("X:8.5 Y:9.7", 59)]), []);
  assert.equal(imageCoordinates([line("X:8.5 Y:9.7 X:9.6 Y:9.0")]).length, 2);
});
test("TSV grouping keeps numeric confidence and filters invalid words", () => {
  const header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
  const result = parseTsv(`${header}\n5\t1\t1\t1\t1\t1\t2\t3\t20\t10\t90\tX:8.5\n5\t1\t1\t1\t1\t2\t22\t3\t20\t10\t80\tY:9.7\n5\t1\t1\t1\t2\t1\t2\t3\t20\t10\t-1\ttrash`);
  assert.equal(result.length, 1); assert.equal(result[0].text, "X:8.5 Y:9.7"); assert.equal(result[0].confidence, 85);
});
test("independent full-line and axis readings agree without inventing digits or confidence", () => {
  const result = consistentCoordinateLine([line("X:11.3Y:13.7", 0)], [line("X:11.3", 85.11)], [line("Y:13.7", 41.41)]);
  assert.equal(result!.confidence, (85.11 + 41.41) / 2);
  assert.deepEqual(imageCoordinates([result!]).map(({ x, y }) => [x, y]), [[11.3, 13.7]]);
  assert.equal(consistentCoordinateLine([line("X:11.3Y:13.1")], [line("X:11.3")], [line("Y:13.7")]), undefined);
  assert.equal(consistentCoordinateLine([line("X311.3Y:13.7")], [line("X311.3")], [line("Y:13.7")]), undefined);
});
test("only bounded official HTTPS image URLs are eligible", () => {
  assert.ok(trustedImageUrl("https://static.web.sdo.com/game/map.png"));
  for (const url of ["http://static.web.sdo.com/map.png", "https://example.com/map.png", "file:///tmp/map.png",
    "https://static.web.sdo.com:8443/map.png", "https://user@static.web.sdo.com/map.png", "https://static.web.sdo.com/map.html"])
    assert.equal(trustedImageUrl(url), false);
});
test("invalid or oversized rasters are rejected before launching an OCR process", async () => {
  assert.equal(rasterDimensions(Buffer.from("not an image")), undefined);
  await assert.rejects(recognizeImage(Buffer.alloc(0)), /10 MiB/);
  await assert.rejects(recognizeImage(Buffer.alloc(10 * 1024 * 1024 + 1)), /10 MiB/);
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(5000, 16); png.writeUInt32BE(5000, 20);
  await assert.rejects(recognizeImage(png), /8 megapixels/);
});
