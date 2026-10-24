import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { extractRewards } from "./source.js";

let browser: Browser;
before(async () => {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim() || (process.platform === "win32" ? [
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync) : undefined);
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
});
after(async () => { await browser?.close(); });

async function fixture(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route("https://static.web.sdo.com/**", route => route.abort());
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  return page;
}

type Item = { name: string; category: string; icon: string; flags: string[] };
const items: Item[] = [
  { name: "狰狞熊头套", category: "头部防具", icon: "head.png", flags: ["珍稀", "独占"] },
  { name: "狂笑守夜菇", category: "家具", icon: "mushroom.png", flags: ["独占"] },
];

// Reduced official reward/tooltip structure. The delayed mouse handler models
// the site's existing script; the extractor must discover the supplied names.
function itemFixture(values: Item[], hydrate = true, initialTooltip = ""): string {
  return `<style>
    .js__db_tooltip { position:relative; display:inline-block; width:76px; height:76px; }
    .db_popup { position:absolute; inset:0; }
    .db-tooltip__wrapper { position:absolute; left:400px; top:100px; width:0; height:0; }
    .panel { width:300px; }
  </style><div class="content__event-reward"><h3>活动奖励</h3>
    <h4><img alt="防具"></h4><ul class="content__item__list">
    ${values.map((item, index) => `<li class="js__db_tooltip">
      <img alt="" class="db-tooltip__item__icon__item_image" width="64" height="64" src="https://static.web.sdo.com/${item.icon}">
      <div class="db_popup" data-ldst-href="/lodestone/playguide/db/item/${index + 1}/"></div></li>`).join("")}
    </ul></div>${initialTooltip}${hydrate ? `<script>
      const items = ${JSON.stringify(values)};
      document.querySelectorAll('.js__db_tooltip').forEach((element, index) => {
        element.addEventListener('mouseenter', () => setTimeout(() => {
          let tooltip = document.querySelector('.db-tooltip__wrapper');
          if (!tooltip) { tooltip = document.createElement('div'); document.body.append(tooltip); }
          tooltip.className = 'db-tooltip db-tooltip__wrapper item_detail_box'; tooltip.style.display = 'block';
          const item = items[index];
          tooltip.innerHTML = '<div class="panel"><img class="db-tooltip__item__icon__item_image" src="https://static.web.sdo.com/' + item.icon + '">' +
            item.flags.map(flag => '<span class="' + (flag === '珍稀' ? 'rare' : 'ex_bind') + '">' + flag + '</span>').join('') +
            '<h2 class="db-tooltip__item__name">' + item.name + '</h2><p class="db-tooltip__item__category">' + item.category +
            '</p><p>不可出售不可在市场出售</p></div>';
        }, 60));
      });
    </script>` : ""}`;
}

test("unnamed reward icons hydrate Chinese item names, categories and flags after hover", { timeout: 15000 }, async () => {
  const page = await fixture(itemFixture(items));
  try {
    const rewards = await extractRewards(page);
    assert.deepEqual(rewards.map(({ name, category }) => ({ name, category })), items.map(({ name, category }) => ({ name, category })));
    assert.deepEqual(rewards[0].flags, ["珍稀", "独占", "不可出售", "不可在市场出售"]);
    assert.ok(rewards[1].description.includes("狂笑守夜菇"));
    assert.ok(rewards.every(reward => !reward.description.includes(reward.name === items[0].name ? items[1].name : items[0].name)));
  } finally { await page.close(); }
});

test("items sharing an icon wait for their own delayed tooltip instead of reusing the previous name", { timeout: 15000 }, async () => {
  const page = await fixture(itemFixture(items.map(item => ({ ...item, icon: "shared.png" }))));
  try {
    assert.deepEqual((await extractRewards(page)).map(reward => reward.name), items.map(item => item.name));
  } finally { await page.close(); }
});

test("stale tooltips from another item cannot fill an unnamed reward", { timeout: 15000 }, async () => {
  const stale = `<div class="db-tooltip__wrapper item_detail_box"><div class="panel">
    <img class="db-tooltip__item__icon__item_image" src="https://static.web.sdo.com/other.png">
    <h2 class="db-tooltip__item__name">别处的物品</h2></div></div>`;
  const page = await fixture(itemFixture([items[0]], false, stale));
  try { assert.deepEqual(await extractRewards(page), []); } finally { await page.close(); }
});

test("a stale tooltip using the same icon still needs a fresh item name", { timeout: 15000 }, async () => {
  const stale = `<div class="db-tooltip__wrapper item_detail_box"><div class="panel">
    <img class="db-tooltip__item__icon__item_image" src="https://static.web.sdo.com/head.png">
    <h2 class="db-tooltip__item__name">先前的物品</h2></div></div>`;
  const page = await fixture(itemFixture([items[0]], false, stale));
  try { assert.deepEqual(await extractRewards(page), []); } finally { await page.close(); }
});

test("hidden item metadata and category artwork keep missing reward names unknown", { timeout: 15000 }, async () => {
  const hidden = `<div class="db-tooltip__wrapper item_detail_box" style="display:none"><div class="panel">
    <img class="db-tooltip__item__icon__item_image" src="https://static.web.sdo.com/head.png">
    <h2 class="db-tooltip__item__name">隐藏的旧物品</h2></div></div>`;
  const page = await fixture(itemFixture([items[0]], false, hidden));
  try { assert.deepEqual(await extractRewards(page), []); } finally { await page.close(); }
});

test("named image rewards and exchange tables retain their existing extraction behavior", { timeout: 15000 }, async () => {
  const page = await fixture(`<div class="rewards"><h4><img alt="坐骑"></h4>
    <img alt="粉红糖豆人" width="64" height="64"><img alt="" width="64" height="64"></div>
    <table><thead><tr><th>可交换道具</th><th>所需数量</th></tr></thead>
    <tbody><tr><td>粉红糖豆人</td><td>350</td></tr><tr><td>糖豆企鹅</td><td>350</td></tr></tbody></table>
    <table><thead><tr><th>新闻导航</th></tr></thead><tbody><tr><td>官网首页</td></tr></tbody></table>`);
  try { assert.deepEqual((await extractRewards(page)).map(reward => reward.name), ["粉红糖豆人", "糖豆企鹅"]); }
  finally { await page.close(); }
});
