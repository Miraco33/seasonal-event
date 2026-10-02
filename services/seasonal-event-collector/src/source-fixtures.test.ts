import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import type { CollectorOverrides } from "./configuration.js";
import { collectEvents, parseDetailPage, type SourceOptions } from "./source.js";

// Reduced DOM fixtures captured from the official 2026 pages on 2026-10-02.
// Time fallbacks are from official news 393210, 391316 and 393660, respectively.
// Image contents without text/alt are intentionally absent: they must remain
// unknown unless a separately verified override is supplied.
const ff15Url = "https://actff1.web.sdo.com/project/20260915ffxv/index.html";
const yokaiUrl = "https://actff1.web.sdo.com/project/20260715youkai-watch/vaz1gqm16a3h/index.html";
const fallGuysUrl = "https://actff1.web.sdo.com/project/20260928ff14fallguys/4kkmxknj3rno/index.html";
const ids = { [ff15Url]: "ffxv-2026", [yokaiUrl]: "yokai-2026", [fallGuysUrl]: "fallguys-2026" };
const noOverrides: CollectorOverrides = { locations: {}, rewards: {}, completion: {} };
const metadataFallbacks: SourceOptions["metadataFallbacks"] = {
  "ffxv-2026": { startAt: "2026-09-24T16:00:00+08:00", endAt: "2026-10-13T23:00:00+08:00" },
  "yokai-2026": { startAt: "2026-08-04T16:00:00+08:00", endAt: "2026-10-05T23:00:00+08:00" },
  "fallguys-2026": { startAt: "2026-10-07T16:00:00+08:00", endAt: "2026-10-27T23:00:00+08:00" },
};
const ff15Html = `<!doctype html><html><head><title>最终幻想XIV x 最终幻想XV 「献给英雄的夜曲」 | 《最终幻想14》官方网站</title></head><body>
  <h2 class="content__overview__schedule"><img alt="活动时间"></h2>
  <div class="quest"><h3><img alt="黑衣青年"></h3>
    <p class="quest__text">在乌尔达哈现世回廊出现的琪琵·嘉奇亚，似乎有什么话想对冒险者说。</p>
    <div class="quest__requirements"><h4>接受条件</h4><dl><dd>等级50（设限特职除外）</dd><dd>完成主线任务“超越幻想，究极神兵”</dd></dl></div>
  </div>
  <h3>关于任务的推进</h3>
  <p>若只有以上任务，则可前往乌尔达哈现世回廊 (X:8.5 Y: 9.7)的NPC“琪琵·嘉奇亚”处接取任务「暗夜来访者」。</p>
  <p>若只有以上2个任务，则可前往格里达尼亚新街 (X:11.4 Y: 11.3)的NPC“诺克提斯”处接取任务「风之使者」。</p>
  <h3>关于「季节活动再现」</h3><h3>参加活动前的准备流程</h3>
  <div class="rewards"><h4><img alt="坐骑"></h4><img alt=""><h4><img alt="防具"></h4><img alt=""></div>
</body></html>`;
const yokaiHtml = `<!doctype html><html><head><title>妖怪手表 艾欧泽亚大集合啦喵！ 2026 | 《最终幻想14》官方网站</title></head><body>
  <h1><img class="event_title" alt=""></h1><h2><img alt="首先从这里开始!接受任务吧!"></h2><h3><img alt="如何接受任务"></h3>
  <a class="js__hover fancybox_ykw" data-fancybox="minion" href="#minion01"><img alt="地缚猫"><img class="on" alt="地缚猫"></a>
  <a class="js__hover fancybox_ykw" data-fancybox="minion" href="#minion02"><img alt="小狛"><img class="on" alt="小狛"></a>
  <div class="weapons"><a class="js__hover fancybox_ykw" data-fancybox="weapon" href="#weapon01"><img alt="百斩斧·赤猫"><img class="on" alt="百斩斧·赤猫"></a></div>
</body></html>`;
const fallGuysRewardNames = [
  "糖豆人针织帽", "糖豆人卫衣", "糖豆人打底裤", "糖豆人运动鞋", "哑光胜者王冠", "闪亮胜者王冠",
  "糖豆犀牛认证密钥", "演技教材·大获全胜", "粉红糖豆人", "糖豆企鹅", "金碟巨豆中心胜者王冠",
  "金碟巨豆中心装饰旗", "金碟巨豆中心甜甜圈障碍柱", "金碟巨豆中心填充墙", "金碟巨豆中心彩虹柱",
  "金碟巨豆中心巨锤", "管弦乐琴乐谱：快快落落糖豆人", "肖像教材：金碟巨豆中心1", "肖像教材：金碟巨豆中心2",
  "肖像教材：金碟巨豆中心3", "民用营养学指南", "金碟游乐场传送网使用券", "追加染剂1",
];
const fallGuysHtml = `<!doctype html><html><head><title>最终幻想14 × Fall Guys 联动活动 | 《最终幻想14》官方网站</title></head><body>
  <h1><img alt="最终幻想14 x Fall Guys"></h1><h2>活动概要</h2><h3>举办时间</h3>
  <p>2026年10月7日16:00 ～ 2026年10月27日22:59</p>
  <h2>参加方法</h2><h3>在《最终幻想14》的世界中创建角色！</h3>
  <h3>将角色等级提升至15级，完成支线任务「前往游乐场」</h3><h4>前往游乐场</h4><p>接取条件</p><p>任意职业 15级</p>
  <h3>完成活动任务「抓紧胜利的王冠！」</h3><h4>抓紧胜利的王冠！</h4><p>接取条件</p><p>任意职业 15级</p>
  <h3>游玩联动任务，获得「金碟声誉」</h3><h3>交换奖励道具</h3><p>将获得的金碟声誉交给「金碟声誉兑换员」来换取各种道具吧。</p>
  <h2>道具兑换</h2><table class="fgs__items__list"><thead><tr><th>可交换道具</th><th><p>所需数量</p><img alt=""></th></tr></thead><tbody>
    ${fallGuysRewardNames.map(name => `<tr><th><div class="fgs__items__list__detail"><img alt=""><div class="fgs__items__list__name">${name}</div></div></th><td><img alt=""><p>410</p></td></tr>`).join("")}
  </tbody></table>
  <table><thead><tr><th>新闻导航</th><th>数量</th></tr></thead><tbody><tr><td>官网首页</td><td>10</td></tr></tbody></table>
</body></html>`;

let browser: Browser;
const previousExecutablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
before(async () => {
  const executablePath = previousExecutablePath?.trim() || (process.platform === "win32" ? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync) : undefined);
  if (executablePath) process.env.PLAYWRIGHT_EXECUTABLE_PATH = executablePath;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => {
  await browser?.close();
  if (previousExecutablePath === undefined) delete process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  else process.env.PLAYWRIGHT_EXECUTABLE_PATH = previousExecutablePath;
});

async function parseFixture(url: string, html: string, options: SourceOptions = {}) {
  const page = await browser.newPage({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  await page.route("**/*", route => route.request().url() === url
    ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }) : route.abort());
  try {
    return await parseDetailPage(page, url, { overrides: noOverrides, eventIds: ids, metadataFallbacks, allowPartial: true, attempts: 1, ...options });
  } finally {
    await page.close();
  }
}

test("FFXV fixture uses the quest image alt and keeps category images out of rewards", { timeout: 15000 }, async () => {
  const event = await parseFixture(ff15Url, ff15Html);
  assert.equal(event.title, "最终幻想XIV x 最终幻想XV 「献给英雄的夜曲」");
  assert.equal(event.questName, "黑衣青年");
  assert.equal(event.questNpc, "琪琵·嘉奇亚");
  assert.equal(event.questLevel, 50);
  assert.equal(event.startAt, "2026-09-24T16:00:00+08:00");
  assert.equal(event.endAt, "2026-10-13T23:00:00+08:00");
  assert.equal(event.location, null);
  assert.deepEqual(event.rewards, []);
});

test("image-only Yokai fixture preserves missing quest/NPC/map fields and deduplicates named rewards", { timeout: 15000 }, async () => {
  const event = await parseFixture(yokaiUrl, yokaiHtml);
  assert.equal(event.title, "妖怪手表 艾欧泽亚大集合啦喵！ 2026");
  assert.equal(event.questName, null);
  assert.equal(event.questNpc, null);
  assert.equal(event.questLevel, null);
  assert.equal(event.location, null);
  assert.equal(event.startAt, "2026-08-04T16:00:00+08:00");
  assert.deepEqual(event.rewards.map(reward => [reward.name, reward.category]), [["地缚猫", "宠物"], ["小狛", "宠物"], ["百斩斧·赤猫", "武器"]]);
});

test("Fall Guys fixture uses the actual activity quest, fresh date window and all 23 exchange names", { timeout: 15000 }, async () => {
  const event = await parseFixture(fallGuysUrl, fallGuysHtml, {
    metadataFallbacks: { "fallguys-2026": { title: "旧公告标题", startAt: "2024-06-01T00:00:00+08:00", endAt: "2024-06-03T00:00:00+08:00", questName: "前往游乐场" } },
  });
  assert.equal(event.title, "最终幻想14 × Fall Guys 联动活动");
  assert.equal(event.questName, "抓紧胜利的王冠！");
  assert.equal(event.questNpc, null);
  assert.equal(event.questLevel, 15);
  assert.equal(event.location, null);
  assert.equal(event.startAt, "2026-10-07T16:00:00+08:00");
  assert.equal(event.endAt, "2026-10-27T23:00:00+08:00");
  assert.deepEqual(event.rewards.map(reward => reward.name), fallGuysRewardNames);
});

test("configured verified metadata wins over DOM while explicit unknown fields remain null", { timeout: 15000 }, async () => {
  const event = await parseFixture(fallGuysUrl, fallGuysHtml, {
    overrides: { ...noOverrides, metadata: { "fallguys-2026": { title: "人工核验的标题", questName: null, questNpc: null, questLevel: null } } },
    metadataFallbacks: { "fallguys-2026": { questNpc: "公告中的NPC", questName: "公告中的任务" } },
  });
  assert.equal(event.title, "人工核验的标题");
  assert.equal(event.questName, null);
  assert.equal(event.questNpc, null);
  assert.equal(event.questLevel, null);
});

test("partial mode still refuses an image-only time window without verified announcement metadata", { timeout: 15000 }, async () => {
  await assert.rejects(parseFixture(ff15Url, ff15Html, { metadataFallbacks: {} }), /required fields \(startAt, endAt\)/);
});

test("strict mode continues to reject missing quest/NPC or missing verified world map", { timeout: 15000 }, async () => {
  await assert.rejects(parseFixture(yokaiUrl, yokaiHtml, { allowPartial: false }), /required fields \(questName, questNpc\)/);
  await assert.rejects(parseFixture(ff15Url, ff15Html, { allowPartial: false }), /missing LOCATION_OVERRIDES/);
});

test("source failures reach the explicit callback and still throw without one", { timeout: 15000 }, async () => {
  const errors: { url: string; error: unknown }[] = [];
  assert.deepEqual(await collectEvents(["not-a-url"], { attempts: 1, onSourceError: (url, error) => errors.push({ url, error }) }), []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].url, "not-a-url");
  assert.ok(errors[0].error instanceof Error);
  await assert.rejects(collectEvents(["not-a-url"], { attempts: 1 }), /invalid URL|Invalid URL|Cannot navigate/);
});
