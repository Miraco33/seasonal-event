import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { displayToWorld, parseVerifiedQuestCatalogue, resolveVerifiedQuest, worldToDisplay } from "./verified-quests.js";

const raw = JSON.parse(readFileSync(new URL("../config/verified-quests.json", import.meta.url), "utf8"));
const catalogue = parseVerifiedQuestCatalogue(raw);
const ffUrl = "https://actff1.web.sdo.com/project/20260915ffxv/index.html";
const ff16Url = "https://actff1.web.sdo.com/project/20261029ffxvi/uvjx9y9g2k2p/index.html";
const fgUrl = "https://actff1.web.sdo.com/project/20260928ff14fallguys/4kkmxknj3rno/index.html";

test("verified FF15 details bind the first quest's location to the last quest's completion", () => {
  const quest = resolveVerifiedQuest("黑衣青年", ffUrl, catalogue.quests)!;
  assert.equal(quest.startQuestId, 68694);
  assert.equal(quest.completion.questId, 68696);
  assert.equal(quest.completion.achievementId, 2241);
  assert.equal(quest.location.territoryId, 130);
  assert.equal(quest.location.mapId, 13);
  assert.deepEqual([quest.location.displayX, quest.location.displayY], [8.5, 9.7]);
  assert.equal(quest.rewards?.length, 13);
});
test("the Fall Guys activity resolves its own NPC rather than its prerequisite", () => {
  const quest = resolveVerifiedQuest("抓紧胜利的王冠!", fgUrl, catalogue.quests)!;
  assert.equal(quest.questNpc, "莱维娜");
  assert.equal(quest.completion.questId, 70337);
  assert.deepEqual([quest.location.territoryId, quest.location.mapId, quest.location.displayX, quest.location.displayY], [144, 196, 4.8, 6.1]);
  assert.equal(resolveVerifiedQuest("前往游乐场", fgUrl, catalogue.quests), undefined);
});
test("FF16 uses the first quest's NPC and game location, official display coordinates, and the final completion", () => {
  const questName = "于烈焰炽灼的大地";
  const quest = resolveVerifiedQuest(questName, ff16Url, catalogue.quests)!;
  assert.equal(quest.questNpc, "新人冒险者");
  assert.equal(quest.questLevel, 50);
  assert.equal(quest.startQuestId, 70332);
  assert.deepEqual(quest.location, { territoryId: 130, mapId: 13, x: -117.61399841308594, y: 4,
    z: -67.13819885253906, displayX: 8.8, displayY: 9.9 });
  assert.deepEqual(quest.evidence.officialDisplay, { x: 8.8, y: 9.8 });
  assert.deepEqual(quest.questChain.map(stage => stage.questId), [70332, 70333, 70334]);
  assert.deepEqual(quest.completion, { questId: 70334, achievementId: 3409 });
  assert.equal(resolveVerifiedQuest(questName, "https://actff1.web.sdo.com/project/20240807ffxvi/", catalogue.quests), quest);
  assert.equal(resolveVerifiedQuest(questName, ff16Url.replace("20261029", "20271029"), catalogue.quests), quest);
  assert.equal(resolveVerifiedQuest(questName, ff16Url.replace("ffxvi", "ffxvii"), catalogue.quests), undefined);
  assert.equal(resolveVerifiedQuest(questName, ffUrl, catalogue.quests), undefined);
  assert.equal(resolveVerifiedQuest("追寻心中隐痛", ff16Url, catalogue.quests), undefined);
});
test("verified details are reusable across a repeat event but never applied to an unrelated source", () => {
  assert.ok(resolveVerifiedQuest("黑衣青年", ffUrl.replace("20260915", "20270915"), catalogue.quests));
  assert.equal(resolveVerifiedQuest("黑衣青年", fgUrl, catalogue.quests), undefined);
  assert.equal(resolveVerifiedQuest("黑衣青年", ffUrl.replace("actff1.web.sdo.com", "example.com"), catalogue.quests), undefined);
  assert.equal(resolveVerifiedQuest(null, ffUrl, catalogue.quests), undefined);
});
test("ambiguous mappings fail rather than selecting an arbitrary quest", () => {
  assert.throws(() => resolveVerifiedQuest("黑衣青年", ffUrl, [catalogue.quests[0], catalogue.quests[0]]), /ambiguous/);
  const duplicate = structuredClone(raw); duplicate.quests.push(duplicate.quests[0]);
  assert.throws(() => parseVerifiedQuestCatalogue(duplicate), /duplicate/);
});
test("world/display conversions round trip at both game map scales and nonzero offsets", () => {
  for (const size of [100, 200, 400]) for (const offset of [-100, 0, 128]) for (const coordinate of [-132.445, 0, 0.811196, 82.0985]) {
    const display = worldToDisplay(coordinate, size, offset);
    assert.ok(Math.abs(displayToWorld(display, size, offset) - coordinate) < 1e-9);
  }
});
test("a mismatched map coordinate cannot pass a numeric-only check", () => {
  const bad = structuredClone(raw); bad.quests[1].location.displayX = 9.6;
  assert.throws(() => parseVerifiedQuestCatalogue(bad), /disagree/);
});
test("official display evidence must be within one displayed decimal of the game location", () => {
  const ff16 = (value: typeof raw) => value.quests.find((quest: { startQuestId: number }) => quest.startQuestId === 70332);
  for (const coordinates of [null, { x: "8.8", y: 9.8 }, { x: 8.8, y: Infinity },
    { x: 8.8, y: 9.85 }, { x: 8.8, y: 9.7 }, { x: 8.6, y: 9.9 }]) {
    const invalid = structuredClone(raw);
    ff16(invalid).evidence.officialDisplay = coordinates;
    assert.throws(() => parseVerifiedQuestCatalogue(invalid), /invalid official display coordinate evidence/);
  }
  const mismatched = structuredClone(raw);
  ff16(mismatched).location.displayY = 9.8;
  assert.throws(() => parseVerifiedQuestCatalogue(mismatched), /coordinates disagree/);
});
test("an initial or prerequisite task cannot replace the verified final completion condition", () => {
  const early = structuredClone(raw); early.quests[0].completion.questId = 68694;
  assert.throws(() => parseVerifiedQuestCatalogue(early), /completion chain/);
  const prerequisite = structuredClone(raw); prerequisite.quests[1].completion.questId = 65970;
  assert.throws(() => parseVerifiedQuestCatalogue(prerequisite), /completion chain/);
  const truncated = structuredClone(raw);
  truncated.quests[0].questChain = [truncated.quests[0].questChain[0]];
  truncated.quests[0].completion = { questId: 68694 };
  assert.throws(() => parseVerifiedQuestCatalogue(truncated), /evidence/);
});
test("broken game-table dependencies and mismatched achievements are rejected", () => {
  const broken = structuredClone(raw); broken.quests[0].questChain[1].previousQuestIds = [];
  assert.throws(() => parseVerifiedQuestCatalogue(broken), /dependency/);
  const achievement = structuredClone(raw); achievement.quests[0].evidence.completionAchievementQuestId = 68694;
  assert.throws(() => parseVerifiedQuestCatalogue(achievement), /evidence/);
});
test("image reward supplements require item evidence for every row", () => {
  const bad = structuredClone(raw); bad.quests[0].evidence.rewardItemIds.pop();
  assert.throws(() => parseVerifiedQuestCatalogue(bad), /rewards/);
});
