import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  extractCoordinates,
  extractNpc,
  extractQuestName,
  parseTimeWindow,
  selectEventTitle,
} from "../dist/source.js";

const allSources = JSON.parse(await readFile(new URL("../history-pages.json", import.meta.url), "utf8"));
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
const strict = process.argv.includes("--strict");
const sinceArgument = process.argv.find((argument) => argument.startsWith("--since="));
const since = sinceArgument ? Number(sinceArgument.slice("--since=".length)) : null;
if (since !== null && (!Number.isInteger(since) || since < 2000 || since > 9999)) {
  throw new Error("--since must be a four-digit year");
}
const sources = since === null
  ? allSources
  : allSources.filter((source) => Number.parseInt(source.label.slice(0, 4), 10) >= since);
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
      const levelMatch = body.match(/等级\s*(\d+)/);
      const rewardCandidates = page.locator(
        "[data-tooltip], [data-original-title], [class*='reward'] [title], [class*='reward'] [aria-label], [class*='reward'] img",
      );
      const rewardCandidateCount = await rewardCandidates.count();
      const rewardNameCount = await rewardCandidates.evaluateAll((elements) => elements.filter((element) =>
        Boolean((element.getAttribute("data-tooltip") ||
          element.getAttribute("data-original-title") ||
          element.getAttribute("title") ||
          element.getAttribute("aria-label") ||
          element.getAttribute("alt") || "").trim()),
      ).length);
      const httpOk = response?.ok() ?? false;
      const titleMatchesExpected = source.expectedTitle === undefined || title === source.expectedTitle;
      const npcMatchesExpected = source.expectedNpc === undefined || npc === source.expectedNpc;
      results.push({
        label: source.label,
        url: source.url,
        status: response?.status(),
        httpOk,
        title,
        expectedTitle: source.expectedTitle || null,
        titleMatchesExpected,
        quest,
        npc,
        expectedNpc: source.expectedNpc || null,
        npcMatchesExpected,
        time,
        questLevel: levelMatch ? Number(levelMatch[1]) : null,
        coordinates,
        rewardCandidateCount,
        rewardNameCount,
        manualReview: source.manualReview || [],
        coreRecognized: Boolean(httpOk && title && quest && npc && time),
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
const exact = results.filter((result) => result.coreRecognized &&
  result.titleMatchesExpected !== false && result.npcMatchesExpected !== false).length;
const completeness = {
  withQuestLevel: results.filter((result) => result.questLevel).length,
  withTextCoordinates: results.filter((result) => result.coordinates).length,
  withNamedRewardCandidates: results.filter((result) => result.rewardNameCount > 0).length,
};
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), since, recognized, exact, total: results.length, completeness, results }, null, 2));
if (strict && exact !== results.length) process.exitCode = 1;
