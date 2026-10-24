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
  const now = Date.now();
  let servedData = data;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
  context.setDefaultTimeout(10000);
  await context.addInitScript(value => { Date.now = () => value; }, now);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await context.route("https://seasonal-event.test/**", route => {
    if (route.request().url().endsWith("events-v2.json")) return route.fulfill({ json: servedData });
    if (new URL(route.request().url()).pathname.startsWith("/official/")) {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<h1>官方来源链接测试页</h1>" });
    }
    return route.fulfill({ contentType: "text/html", body: html });
  });
  await page.goto("https://seasonal-event.test/");
  await page.waitForFunction(() => document.getElementById("state").textContent !== "正在读取");
  assert.deepEqual(errors, []);
  const active = data.events.filter(event => Date.parse(event.startAt) <= now && now < Date.parse(event.endAt));
  const upcoming = data.events.filter(event => Date.parse(event.startAt) > now);
  assert.equal(await page.locator("#events .event-card").count(), active.length);
  assert.equal(await page.locator("#upcoming .event-card").count(), upcoming.length);
  assert.equal(await page.locator("#pending-events .event-card").count(), data.pendingEvents?.length ?? 0);
  const cards = page.locator("#events .event-card");
  for (let index = 0; index < active.length; index++) {
    const event = active.sort((a, b) => Date.parse(a.endAt) - Date.parse(b.endAt))[index];
    const text = await cards.nth(index).innerText();
    if (event.location) assert.ok(!text.includes("坐标尚未核验"));
    else assert.match(text, /坐标尚未核验/);
  }
  await mkdir(resolve("output"), { recursive: true });
  await page.screenshot({ path: resolve("output/status-page.png"), fullPage: true });

  const hour = 60 * 60 * 1000;
  const at = offset => new Date(now + offset).toISOString();
  const common = {
    questName: null, questNpc: null, questLevel: null, questId: null, achievementId: null,
    location: null, rewards: [], sourceUrl: "https://seasonal-event.test/official/activity", lastVerifiedAt: at(-hour),
  };
  const fixture = {
    schemaVersion: 2, dataVersion: 42, publishedAt: at(0), collectionStatus: { status: "ok", code: "healthy" },
    events: [
      { ...common, id: "active", title: "起止时间已确认的当前活动", startAt: at(-hour), endAt: at(hour) },
      { ...common, id: "future", title: "起止时间已确认的未来活动", startAt: at(hour), endAt: at(2 * hour) },
    ],
    pendingEvents: [
      { ...common, id: "pending-future", title: "结束日期尚未公布的联动预告", startAt: at(hour), endCondition: "8.0版本更新维护前" },
      { ...common, id: "pending-past", title: "已过公布开始时间的待定活动", startAt: at(-48 * hour), endCondition: "后续公告公布为准", lastVerifiedAt: at(-25 * hour) },
      { ...common, id: "pending-boundary", title: "恰满24小时的核验资料", startAt: at(-hour), endCondition: "官方另行通知", lastVerifiedAt: at(-24 * hour) },
    ],
  };
  async function show(value) {
    servedData = value;
    await page.reload();
    await page.waitForFunction(() => document.getElementById("state").textContent !== "正在读取");
  }
  await show(fixture);
  assert.equal(await page.locator("#active-count").innerText(), "1 个");
  assert.equal(await page.locator("#total-count").innerText(), "共收录 5 个活动");
  assert.equal(await page.locator("#events .event-card").count(), 1);
  assert.equal(await page.locator("#upcoming .event-card").count(), 1);
  assert.equal(await page.locator("#pending-events .event-card").count(), 3);
  const pending = page.locator("#pending-events");
  assert.equal(await pending.locator(".tag").allTextContents().then(tags => tags.every(tag => tag === "结束日期待定")), true);
  assert.equal(await pending.locator(".pending-note").allTextContents().then(notes => notes.every(note => note === "开放情况请查看官网。")), true);
  assert.match(await pending.innerText(), /8\.0版本更新维护前/);
  const expectedStart = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(fixture.pendingEvents[0].startAt));
  const futureTime = await pending.locator(".event-card").filter({ hasText: fixture.pendingEvents[0].title }).locator(".time").innerText();
  assert.ok(futureTime.includes(`开始：${expectedStart}（北京时间）`));
  assert.ok(futureTime.endsWith(`结束：${fixture.pendingEvents[0].endCondition}`));
  assert.doesNotMatch(await pending.innerText(), /进行中|即将开始|时间未知|Invalid Date/);
  const stale = pending.locator(".event-card").filter({ hasText: "已过公布开始时间的待定活动" });
  assert.match(await stale.innerText(), /资料待重新核验/);
  const boundary = pending.locator(".event-card").filter({ hasText: "恰满24小时的核验资料" });
  assert.doesNotMatch(await boundary.innerText(), /资料待重新核验/);
  assert.match(await stale.innerText(), /任务：待确认/);
  assert.match(await stale.innerText(), /接取 NPC：待确认/);
  assert.match(await stale.innerText(), /奖励：官网信息尚未提取/);
  assert.match(await stale.innerText(), /坐标尚未核验/);
  const source = stale.locator("a.source");
  assert.equal(await source.getAttribute("href"), common.sourceUrl);
  assert.equal(await source.getAttribute("target"), "_blank");
  assert.equal(await source.getAttribute("rel"), "noopener noreferrer");
  const opened = context.waitForEvent("page");
  await source.click();
  const sourcePage = await opened;
  await sourcePage.waitForLoadState("domcontentloaded");
  assert.equal(sourcePage.url(), common.sourceUrl);
  assert.equal(await sourcePage.locator("h1").innerText(), "官方来源链接测试页");
  await sourcePage.close();
  await page.screenshot({ path: resolve("output/status-page-pending-fixture.png"), fullPage: true });
  await page.setViewportSize({ width: 375, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await page.screenshot({ path: resolve("output/status-page-pending-mobile-fixture.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 1100 });

  const markup = '<img src=x onerror="window.pendingInjected=true"><script>window.pendingInjected=true</script>';
  const malicious = structuredClone(fixture);
  malicious.pendingEvents = [{ ...fixture.pendingEvents[0], title: markup, endCondition: markup, questName: markup, questNpc: markup }];
  await show(malicious);
  assert.equal(await pending.locator("h3").innerText(), markup);
  assert.match(await pending.locator(".time").innerText(), /<script>/);
  assert.equal(await pending.locator("img,script").count(), 0);
  assert.equal(await page.evaluate(() => window.pendingInjected), undefined);

  const incomplete = structuredClone(fixture);
  incomplete.pendingEvents = [];
  for (const key of ["id", "title", "startAt", "endCondition", "sourceUrl", "lastVerifiedAt"]) {
    const event = { ...fixture.pendingEvents[0] };
    delete event[key];
    incomplete.pendingEvents.push(event);
  }
  incomplete.pendingEvents.push({ ...fixture.pendingEvents[0], sourceUrl: "javascript:window.pendingInjected=true" });
  incomplete.pendingEvents.push({ ...fixture.pendingEvents[0], startAt: "not-a-date" });
  incomplete.pendingEvents.push({ ...fixture.pendingEvents[0], endAt: at(2 * hour) });
  await show(incomplete);
  assert.equal(await pending.locator(".event-card").count(), 0);
  assert.match(await pending.innerText(), /缺少必要资料.*暂不展示/);
  assert.doesNotMatch(await pending.innerText(), /未命名活动|时间未知|Invalid Date|8\.0/);
  assert.equal(await page.locator("#active-count").innerText(), "1 个");
  const legacy = structuredClone(fixture);
  delete legacy.pendingEvents;
  await show(legacy);
  assert.equal(await pending.locator(".event-card").count(), 0);
  assert.match(await pending.innerText(), /暂无已核验/);
  assert.equal(await page.locator("#active-count").innerText(), "1 个");

  await show({ ...fixture, events: [], collectionStatus: { status: "alert", code: "candidate_discovery_failed" } });
  assert.match(await page.locator("#state").innerText(), /告警/);
  assert.match(await page.locator("#events").innerText(), /采集有告警.*查看官网确认/);
  assert.equal(await pending.locator(".event-card").count(), 3, "pending cards remain visible when no confirmed active event exists");
  assert.deepEqual(errors, []);
  console.log(`Status page verified using the local virtual origin: ${active.length} active / ${upcoming.length} upcoming baseline; pending separation, official link, >24h freshness, plain-text markup, missing fields, old feed and collection alerts passed.`);
} finally { await browser.close(); }
