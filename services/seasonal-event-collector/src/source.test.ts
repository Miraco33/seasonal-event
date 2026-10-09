import assert from "node:assert/strict";
import test from "node:test";

test("recognizes a seasonal quest heading with the official NPC introduction before its requirements", () => {
  assert.equal(extractQuestName("新生庆典与音乐的轨迹\n舰尾楼的异国的诗人有点在意某件事。\n接受任务条件\n等级15", "新生庆典与音乐的轨迹"), "新生庆典与音乐的轨迹");
});
import {
  collectEvents,
  extractCoordinates,
  extractNpc,
  extractQuestName,
  parseTimeWindow,
  resolveCompletion,
  resolveLocation,
  resolveRewards,
  selectEventTitle,
} from "./source.js";

test("requires verified seasonal-event source URLs instead of guessing from the general news page", async () => {
  await assert.rejects(collectEvents([]), /SOURCE_URLS/);
});

test("parses the 2026 Rising time window and makes the end exclusive", () => {
  const result = parseTimeWindow("2026年8月27日15:00 ～ 9月10日22:59");
  assert.deepEqual(result, {
    startAt: "2026-08-27T15:00:00+08:00",
    endAt: "2026-09-10T23:00:00+08:00",
  });
});

test("parses the displayed quest coordinates from an official activity page", () => {
  assert.deepEqual(extractCoordinates("利姆萨·罗敏萨上层甲板 X:11.0 Y:12.8"), { x: 11, y: 12.8 });
  assert.deepEqual(extractCoordinates("利姆萨罗敏萨上层甲板（X:11，Y:13）"), { x: 11, y: 13 });
});

test("selects the activity title instead of the generic seasonal-event heading", () => {
  assert.equal(
    selectEventTitle(["", "SEASONAL EVENT", "新生庆典与音乐的轨迹", "接受任务条件"]),
    "新生庆典与音乐的轨迹",
  );
});

test("rejects collaboration navigation and instruction headings in favor of the official document title", () => {
  assert.equal(selectEventTitle([
    "活动概要", "举办时间", "参加方法", "关于任务的推进", "关于「季节活动再现」",
    "在《最终幻想14》的世界中创建角色！", "将角色等级提升至15级，完成支线任务「前往游乐场」",
    "完成活动任务「抓紧胜利的王冠！」", "游玩联动任务，获得「金碟声誉」", "交换奖励道具", "道具兑换",
  ], "最终幻想14 × Fall Guys 联动活动 | 《最终幻想14》官方网站"), "最终幻想14 × Fall Guys 联动活动");
  assert.equal(selectEventTitle(["活动概要", "关于任务的推进"], "最终幻想14官方网站"), null);
});

test("recognizes a historical quest heading immediately preceding its requirements", () => {
  const body = "SEASONAL EVENT\n新生庆典与音乐的轨迹\n接受任务条件\n等级15";
  assert.equal(extractQuestName(body, "新生庆典与音乐的轨迹"), "新生庆典与音乐的轨迹");
});

test("does not substitute an activity title or a prerequisite for the activity quest name", () => {
  assert.equal(extractQuestName("妖怪手表 艾欧泽亚大集合啦喵！", "妖怪手表 艾欧泽亚大集合啦喵！"), null);
  assert.equal(extractQuestName("完成支线任务「前往游乐场」\n完成活动任务「抓紧胜利的王冠！」", "最终幻想14 × Fall Guys 联动活动"), "抓紧胜利的王冠！");
});

test("extracts the quest NPC from the official activity introduction", () => {
  assert.equal(
    extractNpc("舰尾楼的异国的诗人有点在意某件事。"),
    "异国的诗人",
  );
  assert.equal(extractNpc("在乌尔达哈现世回廊出现的琪琵·嘉奇亚，似乎有什么话想对冒险者说。"), "琪琵·嘉奇亚");
});

test("extracts NPC names from historical official introduction wording", () => {
  assert.equal(extractNpc("米·凯特露天剧场的阿姆·加兰基想找冒险者帮忙。"), "阿姆·加兰基");
  assert.equal(extractNpc("红玉大路国际市场的异国的诗人有事情想拜托冒险者。"), "异国的诗人");
  assert.equal(extractNpc("米·凯特露天剧场的莉赛特·德·瓦伦提昂有话想对冒险者说。"), "莉赛特·德·瓦伦提昂");
  assert.equal(extractNpc("活动期间，与NPC戈德里库兰对话，接取节日任务。"), "戈德里库兰");
  assert.equal(extractNpc("活动期间和以下地点出现的管家之王对话，可以接取节日任务。"), "管家之王");
  assert.equal(extractNpc("活动期间，以下地点会出现星芒节执行委员长。"), "星芒节执行委员长");
  assert.equal(extractNpc("米·凯特露天剧场的阿姆·加兰基好像有事情想找人帮忙。"), "阿姆·加兰基");
  assert.equal(extractNpc("米·凯特露天剧场的阿姆·加兰基好像有事想拜托冒险者。"), "阿姆·加兰基");
  assert.equal(extractNpc("监视着庆典的冒险者行会的调查员正在等待协助。"), "调查员");
  assert.equal(extractNpc("舰尾楼的辰监察想请冒险者协助举办降神节。"), "辰监察");
  assert.equal(extractNpc("乌尔达哈的琪琵·嘉奇亚在寻找能够帮助的人。"), "琪琵·嘉奇亚");
  assert.equal(extractNpc("旧格里达尼亚的南瓜头女人有活动想要介绍给冒险者。"), "南瓜头女人");
  assert.equal(extractNpc("太阳海岸的红莲节执行委员玛雅尔·莫雅尔想请冒险者帮忙。"), "玛雅尔·莫雅尔");
});

test("rejects a page without a complete time window", () => {
  assert.equal(parseTimeWindow("2026年8月27日15:00"), null);
});

test("parses numeric date separators, full-width clock punctuation and weekday labels", () => {
  assert.deepEqual(parseTimeWindow("2026/9/24 16:00 — 2026/10/13 22:59"), {
    startAt: "2026-09-24T16:00:00+08:00", endAt: "2026-10-13T23:00:00+08:00",
  });
  assert.deepEqual(parseTimeWindow("2026年10月7日（周三）16：00 至 10月27日22：59"), {
    startAt: "2026-10-07T16:00:00+08:00", endAt: "2026-10-27T23:00:00+08:00",
  });
});

test("rejects impossible calendar dates, malformed clocks and non-positive windows", () => {
  for (const text of [
    "2026年2月30日16:00 ～ 3月2日22:59", "2026年9月24日25:00 ～ 10月13日22:59",
    "2026年9月24日16:99 ～ 10月13日22:59", "2026年9月24日16:00 ～ 9月24日16:00",
    "2026年9月24日16:00 ～ 2025年10月13日22:59", "2026年9月24日16:00 ～ 10月13日22:599",
  ]) assert.equal(parseTimeWindow(text), null, text);
});

test("handles an event whose end date crosses into the next year", () => {
  assert.deepEqual(parseTimeWindow("2026年12月20日15:00 ～ 1月5日22:59"), {
    startAt: "2026-12-20T15:00:00+08:00",
    endAt: "2027-01-05T23:00:00+08:00",
  });
});

test("keeps an exact official end boundary without adding a minute", () => {
  assert.deepEqual(parseTimeWindow("2025年8月14日14:00 ～ 2025年8月29日14:00"), {
    startAt: "2025-08-14T14:00:00+08:00",
    endAt: "2025-08-29T14:00:00+08:00",
  });
});

test("parses historical start and end boundaries split across lines", () => {
  assert.deepEqual(parseTimeWindow("活动时间\n2015年3月13日14:00开始\n2015年3月26日14:00结束"), {
    startAt: "2015-03-13T14:00:00+08:00",
    endAt: "2015-03-26T14:00:00+08:00",
  });
});

test("resolves world coordinates only from the matching event override", () => {
  const previousOverrides = process.env.LOCATION_OVERRIDES;
  process.env.LOCATION_OVERRIDES = JSON.stringify({
    "the-rising-2026": { territoryId: 129, mapId: 23, x: 100, y: 200, z: 0 },
  });

  try {
    assert.deepEqual(resolveLocation("the-rising-2026", { x: 11, y: 12.8 }), {
      territoryId: 129,
      mapId: 23,
      x: 100,
      y: 200,
      z: 0,
      displayX: 11,
      displayY: 12.8,
    });
  } finally {
    if (previousOverrides === undefined) delete process.env.LOCATION_OVERRIDES;
    else process.env.LOCATION_OVERRIDES = previousOverrides;
  }
});

test("uses a verified world-coordinate override when the page has no displayed coordinates", () => {
  const previousOverrides = process.env.LOCATION_OVERRIDES;
  process.env.LOCATION_OVERRIDES = JSON.stringify({
    "the-rising-2026": { territoryId: 128, mapId: 11, x: -9.61439, y: 39.9998, z: 82.0985, displayX: 11, displayY: 12.8 },
  });

  try {
    assert.deepEqual(resolveLocation("the-rising-2026", null), {
      territoryId: 128,
      mapId: 11,
      x: -9.61439,
      y: 39.9998,
      z: 82.0985,
      displayX: 11,
      displayY: 12.8,
    });
  } finally {
    if (previousOverrides === undefined) delete process.env.LOCATION_OVERRIDES;
    else process.env.LOCATION_OVERRIDES = previousOverrides;
  }
});

test("preserves verified displayed coordinates when page-wide text contains another quest location", () => {
  assert.deepEqual(resolveLocation("fallguys-2026", { x: 9.6, y: 9.0 }, {
    locations: { "fallguys-2026": { territoryId: 144, mapId: 143, x: -55, y: -4, z: -72, displayX: 4.8, displayY: 6.1 } },
    rewards: {}, completion: {},
  }), { territoryId: 144, mapId: 143, x: -55, y: -4, z: -72, displayX: 4.8, displayY: 6.1 });
});

test("uses verified reward and completion overrides for image-only official pages", () => {
  const previousRewards = process.env.REWARD_OVERRIDES;
  const previousCompletion = process.env.COMPLETION_OVERRIDES;
  process.env.REWARD_OVERRIDES = JSON.stringify({
    "the-rising-2026": [{ name: "迷你乌克·拉玛特", category: "宠物", description: "", flags: [] }],
  });
  process.env.COMPLETION_OVERRIDES = JSON.stringify({
    "the-rising-2026": { questId: 71046, achievementId: 3875 },
  });

  try {
    assert.deepEqual(resolveRewards("the-rising-2026", []), [
      { name: "迷你乌克·拉玛特", category: "宠物", description: "", flags: [] },
    ]);
    assert.deepEqual(resolveCompletion("the-rising-2026"), { questId: 71046, achievementId: 3875 });
  } finally {
    if (previousRewards === undefined) delete process.env.REWARD_OVERRIDES;
    else process.env.REWARD_OVERRIDES = previousRewards;
    if (previousCompletion === undefined) delete process.env.COMPLETION_OVERRIDES;
    else process.env.COMPLETION_OVERRIDES = previousCompletion;
  }
});

test("fails without an event override even when legacy global defaults are set", () => {
  const previousOverrides = process.env.LOCATION_OVERRIDES;
  const fallbackNames = ["DEFAULT_TERRITORY_ID", "DEFAULT_MAP_ID", "DEFAULT_WORLD_X", "DEFAULT_WORLD_Y", "DEFAULT_WORLD_Z"] as const;
  const previousFallbacks = fallbackNames.map(name => [name, process.env[name]] as const);
  process.env.LOCATION_OVERRIDES = "{}";
  Object.assign(process.env, {
    DEFAULT_TERRITORY_ID: "129",
    DEFAULT_MAP_ID: "23",
    DEFAULT_WORLD_X: "100",
    DEFAULT_WORLD_Y: "200",
    DEFAULT_WORLD_Z: "0",
  });

  try {
    assert.throws(
      () => resolveLocation("the-rising-2026", { x: 11, y: 12.8 }),
      /missing LOCATION_OVERRIDES entry for event: the-rising-2026/,
    );
  } finally {
    if (previousOverrides === undefined) delete process.env.LOCATION_OVERRIDES;
    else process.env.LOCATION_OVERRIDES = previousOverrides;
    for (const [name, value] of previousFallbacks) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
