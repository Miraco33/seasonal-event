import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  extractCoordinates,
  extractNpc,
  extractQuestName,
  parseTimeWindow,
  selectEventTitle,
} from "../dist/source.js";

const sources = JSON.parse(await readFile(new URL("../history-pages.json", import.meta.url), "utf8"));
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
const strict = process.argv.includes("--strict");
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const results = [];

try {
  const page = await browser.newPage({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  for (const source of sources) {
    try {
      const response = await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(900);
      const body = await page.locator("body").innerText();
      const headings = await page.locator("h1,h2,h3").allInnerTexts();
      const title = selectEventTitle(headings);
      const time = parseTimeWindow(body);
      const quest = extractQuestName(body, title || "");
      const npc = extractNpc(body);
      const coordinates = extractCoordinates(body);
      const rewardImages = await page
        .locator("[class*='reward'] img, [class*='item'] .js__db_tooltip img")
        .count();
      results.push({
        label: source.label,
        url: source.url,
        status: response?.status(),
        title,
        quest,
        npc,
        time,
        coordinates,
        rewardImages,
        manualReview: source.manualReview || [],
        coreRecognized: Boolean(title && quest && npc && time),
      });
    } catch (error) {
      results.push({
        label: source.label,
        url: source.url,
        error: error instanceof Error ? error.message : String(error),
        manualReview: source.manualReview || [],
        coreRecognized: false,
      });
    }
  }
} finally {
  await browser.close();
}

const recognized = results.filter((result) => result.coreRecognized).length;
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), recognized, total: results.length, results }, null, 2));
if (strict && recognized !== results.length) process.exitCode = 1;
