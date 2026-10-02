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
  assert.equal(await page.locator("#events .event-card").count(), 2);
  assert.equal(await page.locator("#upcoming .event-card").count(), 1);
  assert.match(await page.locator("#events").innerText(), /坐标尚未核验/);
  await mkdir(resolve("output"), { recursive: true });
  await page.screenshot({ path: resolve("output/status-page.png"), fullPage: true });
  data.events = [];
  data.collectionStatus = { status: "alert", code: "candidate_discovery_failed" };
  await page.reload();
  await page.waitForFunction(() => document.getElementById("state").textContent.includes("告警"));
  assert.match(await page.locator("#events").innerText(), /采集有告警.*查看官网确认/);
  assert.deepEqual(errors, []);
  console.log("Status page verified: two active cards, one upcoming card, explicit missing coordinates and source failure warning.");
} finally { await browser.close(); }
