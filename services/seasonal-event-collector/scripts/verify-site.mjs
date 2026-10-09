import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const html = await readFile(new URL("../../../site/index.html", import.meta.url), "utf8");
const data = JSON.parse(await readFile(new URL("../../../data/seasonal-event/events-v2.json", import.meta.url), "utf8"));
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || (process.platform === "win32" ? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(existsSync) : undefined);
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://seasonal-event.test/**", route => {
    if (route.request().url().endsWith("events-v2.json")) return route.fulfill({ json: data });
    return route.fulfill({ contentType: "text/html", body: html });
  });
  await page.goto("https://seasonal-event.test/");
  await page.waitForFunction(() => document.getElementById("state").textContent !== "正在读取");
  assert.deepEqual(errors, []);
  const now = Date.now();
  const active = data.events.filter(event => Date.parse(event.startAt) <= now && now < Date.parse(event.endAt));
  const upcoming = data.events.filter(event => Date.parse(event.startAt) > now);
  assert.equal(await page.locator("#events .event-card").count(), active.length);
  assert.equal(await page.locator("#upcoming .event-card").count(), upcoming.length);
  const cards = page.locator("#events .event-card");
  for (let index = 0; index < active.length; index++) {
    const event = active.sort((a, b) => Date.parse(a.endAt) - Date.parse(b.endAt))[index];
    const text = await cards.nth(index).innerText();
    if (event.location) assert.ok(!text.includes("坐标尚未核验"));
    else assert.match(text, /坐标尚未核验/);
  }
  await mkdir(resolve("output"), { recursive: true });
  await page.screenshot({ path: resolve("output/status-page.png"), fullPage: true });
  data.events = [];
  data.collectionStatus = { status: "alert", code: "candidate_discovery_failed" };
  await page.reload();
  await page.waitForFunction(() => document.getElementById("state").textContent.includes("告警"));
  assert.match(await page.locator("#events").innerText(), /采集有告警.*查看官网确认/);
  assert.deepEqual(errors, []);
  console.log(`Status page verified: ${active.length} active cards, ${upcoming.length} upcoming cards, correct map availability and source failure warning.`);
} finally { await browser.close(); }
