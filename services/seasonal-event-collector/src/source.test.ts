import assert from "node:assert/strict";
import test from "node:test";
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
    endAt: "2026-09-10T15:00:00.000Z",
  });
});

test("parses the displayed quest coordinates from an official activity page", () => {
  assert.deepEqual(extractCoordinates("利姆萨·罗敏萨上层甲板 X:11.0 Y:12.8"), { x: 11, y: 12.8 });
});

test("selects the activity title instead of the generic seasonal-event heading", () => {
  assert.equal(
    selectEventTitle(["", "SEASONAL EVENT", "新生庆典与音乐的轨迹", "接受任务条件"]),
    "新生庆典与音乐的轨迹",
  );
});

test("uses the activity title as the quest name without treating the requirements heading as a name", () => {
  const body = "SEASONAL EVENT\n新生庆典与音乐的轨迹\n接受任务条件\n等级15";
  assert.equal(extractQuestName(body, "新生庆典与音乐的轨迹"), "新生庆典与音乐的轨迹");
});

test("extracts the quest NPC from the official activity introduction", () => {
  assert.equal(
    extractNpc("舰尾楼的异国的诗人有点在意某件事。"),
    "异国的诗人",
  );
});

test("rejects a page without a complete time window", () => {
  assert.equal(parseTimeWindow("2026年8月27日15:00"), null);
});

test("handles an event whose end date crosses into the next year", () => {
  assert.deepEqual(parseTimeWindow("2026年12月20日15:00 ～ 1月5日22:59"), {
    startAt: "2026-12-20T15:00:00+08:00",
    endAt: "2027-01-05T15:00:00.000Z",
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
    "the-rising-2026": { territoryId: 128, mapId: 11, x: -9.61439, y: 39.9998, z: 82.0985 },
  });

  try {
    assert.deepEqual(resolveLocation("the-rising-2026", null), {
      territoryId: 128,
      mapId: 11,
      x: -9.61439,
      y: 39.9998,
      z: 82.0985,
    });
  } finally {
    if (previousOverrides === undefined) delete process.env.LOCATION_OVERRIDES;
    else process.env.LOCATION_OVERRIDES = previousOverrides;
  }
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
