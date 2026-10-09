import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { loadCollectorConfiguration } from "../dist/configuration.js";
import { parseDetailPage } from "../dist/source.js";

const rounds = Number(process.argv.find(value => value.startsWith("--rounds="))?.split("=")[1] ?? 3);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
if (!process.env.PLAYWRIGHT_EXECUTABLE_PATH && process.platform === "win32") {
  process.env.PLAYWRIGHT_EXECUTABLE_PATH = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
}
const index = loadCollectorConfiguration().overrides.gameIndex;
const overrides = { locations: {}, rewards: {}, completion: {}, verifiedQuests: [], gameIndex: index };
const cases = [
  { url: "https://actff1.web.sdo.com/project/20260915ffxv/index.html", quest: "黑衣青年", id: "image-ffxv",
    window: { startAt: "2026-09-24T16:00:00+08:00", endAt: "2026-10-13T23:00:00+08:00" } },
  { url: "https://actff1.web.sdo.com/project/20260928ff14fallguys/4kkmxknj3rno/index.html", quest: "抓紧胜利的王冠！", id: "image-fallguys" },
  { url: "https://actff1.web.sdo.com/project/20250912therising/gdx2t316l329/", quest: "新生庆典与拉诺西亚的小小冒险", id: "image-new-seasonal" },
  { url: "https://actff1.web.sdo.com/project/20261005All_Saints_Wake/hjwff6jkcti4/index.html", quest: "守护天节与奇妙的人偶们", id: "image-next-seasonal" },
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
const results = [];
const deadline = setTimeout(() => { console.error("Image source verification exceeded five minutes"); process.exit(1); }, 300000);
try {
  for (let round = 1; round <= rounds; round++) {
    for (const item of cases) {
      const page = await browser.newPage({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });
      const issues = [];
      const startedAt = Date.now();
      try {
        const event = await parseDetailPage(page, item.url, { eventIds: { [item.url]: item.id }, overrides, allowPartial: true,
          metadataFallbacks: item.window ? { [item.id]: item.window } : {},
          onEnrichmentIssue: (url, code, message) => issues.push({ url, code, message }) });
        assert.equal(event.questName, item.quest);
        const expected = index.quests.filter(quest => quest.name === item.quest);
        assert.equal(expected.length, 1);
        const root = expected[0];
        assert.deepEqual(issues, [], "actual image recognition must succeed without an event-specific catalogue or map override");
        assert.equal(event.questNpc, root.npc.name);
        assert.equal(event.location?.mapId, root.location.mapId);
        assert.equal(event.location?.territoryId, root.location.territoryId);
        assert.deepEqual([event.location?.displayX, event.location?.displayY], [root.location.mapX, root.location.mapY]);
        assert.deepEqual([event.location.x, event.location.y, event.location.z], [root.location.x, root.location.y, root.location.z]);
        if (item.quest === "黑衣青年") assert.equal(event.questId, 68696);
        if (item.quest === "抓紧胜利的王冠！") { assert.equal(event.questId, 70337); assert.equal(event.rewards.length, 23); }
        results.push({ round, url: item.url, quest: event.questName, npc: event.questNpc, location: event.location,
          questId: event.questId, achievementId: event.achievementId, durationMs: Date.now() - startedAt, issues });
        console.log(JSON.stringify(results.at(-1)));
      } finally { await page.close(); }
    }
  }
} finally {
  clearTimeout(deadline);
  await browser.close();
  await mkdir(resolve("output"), { recursive: true });
  await writeFile(resolve("output/image-source-verification.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), rounds,
    gameVersion: index.gameVersion, catalogueDisabled: true, results }, null, 2) + "\n");
}
