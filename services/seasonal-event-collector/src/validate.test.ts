import assert from "node:assert/strict";
import test from "node:test";
import { validateDocument } from "./validate.js";

const baseEvent = {
  id: "the-rising-2026",
  title: "新生庆典与音乐的轨迹",
  startAt: "2026-08-27T07:00:00.000Z",
  endAt: "2026-09-10T15:00:00.000Z",
  questName: "新生庆典与音乐的轨迹",
  questLevel: 15,
  questNpc: "异国的诗人",
  location: { territoryId: 129, mapId: 23, x: 100, y: 200, z: 0 },
  achievementId: null,
  rewards: [{ name: "迷你乌克·拉玛特", category: "宠物", description: "", flags: [] }],
  sourceUrl: "https://actff1.web.sdo.com/project/example",
  lastVerifiedAt: "2026-08-25T00:00:00.000Z",
};

test("accepts a valid event document", () => {
  assert.doesNotThrow(() => validateDocument({ schemaVersion: 1, dataVersion: 1, publishedAt: new Date().toISOString(), events: [baseEvent] }));
});

test("accepts omitted, null, and positive integer quest ids", () => {
  for (const questId of [undefined, null, 1, 65535]) {
    assert.doesNotThrow(() => validateDocument({
      schemaVersion: 1,
      dataVersion: 1,
      publishedAt: new Date().toISOString(),
      events: [{ ...baseEvent, questId }],
    }));
  }
});

test("rejects invalid quest ids", () => {
  for (const questId of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => validateDocument({
      schemaVersion: 1,
      dataVersion: 1,
      publishedAt: new Date().toISOString(),
      events: [{ ...baseEvent, questId }],
    }), /questId/);
  }
});

test("accepts valid optional teleport targets", () => {
  for (const teleport of [null, { aetheryteId: 8, subIndex: 0 }, { aetheryteId: 70, subIndex: 255 }]) {
    assert.doesNotThrow(() => validateDocument({
      schemaVersion: 1,
      dataVersion: 1,
      publishedAt: new Date().toISOString(),
      events: [{ ...baseEvent, teleport }],
    }));
  }
});

test("rejects invalid teleport targets", () => {
  const invalidTargets = [
    { teleport: { aetheryteId: 0, subIndex: 0 }, error: /teleport aetheryte/ },
    { teleport: { aetheryteId: 8.5, subIndex: 0 }, error: /teleport aetheryte/ },
    { teleport: { aetheryteId: 8, subIndex: -1 }, error: /teleport subIndex/ },
    { teleport: { aetheryteId: 8, subIndex: 256 }, error: /teleport subIndex/ },
  ];

  for (const { teleport, error } of invalidTargets) {
    assert.throws(() => validateDocument({
      schemaVersion: 1,
      dataVersion: 1,
      publishedAt: new Date().toISOString(),
      events: [{ ...baseEvent, teleport }],
    }), error);
  }
});

test("rejects duplicate event ids", () => {
  assert.throws(() => validateDocument({ schemaVersion: 1, dataVersion: 1, publishedAt: new Date().toISOString(), events: [baseEvent, baseEvent] }), /duplicate/);
});

test("rejects an invalid event window", () => {
  assert.throws(() => validateDocument({ schemaVersion: 1, dataVersion: 1, publishedAt: new Date().toISOString(), events: [{ ...baseEvent, endAt: baseEvent.startAt }] }), /window/);
});

test("rejects an activity with no item rewards", () => {
  assert.throws(() => validateDocument({
    schemaVersion: 1,
    dataVersion: 1,
    publishedAt: new Date().toISOString(),
    events: [{ ...baseEvent, rewards: [] }],
  }), /missing rewards/);
});
