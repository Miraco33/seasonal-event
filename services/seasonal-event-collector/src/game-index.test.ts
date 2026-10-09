import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { automaticCompletion, matchImageQuest, parseGameDataIndex, type IndexedQuest } from "./game-index.js";
import type { OcrLine } from "./image-ocr.js";

const raw = JSON.parse(readFileSync(new URL("../config/game-quest-index.json", import.meta.url), "utf8"));
const index = parseGameDataIndex(raw);
const line = (text: string, confidence = 95): OcrLine => ({ text, confidence, words: [] });
const quest = (name: string): IndexedQuest => index.quests.find(quest => quest.name === name)!;
const evidence = (root: IndexedQuest): OcrLine[] => [line(`X:${root.location!.mapX} Y:${root.location!.mapY}`), line(root.npc!.name), line(root.location!.mapNames.map)];

test("a new seasonal quest absent from the manual catalogue can verify its NPC and actual game map", () => {
  const root = quest("守护天节与回归的马戏团");
  assert.ok(root);
  const details = matchImageQuest(root.name, "", evidence(root), index);
  assert.equal(details.code, "verified");
  assert.equal(details.npc, root.npc!.name);
  assert.deepEqual([details.location!.mapId, details.location!.x, details.location!.z], [root.location!.mapId, root.location!.x, root.location!.z]);
});
test("the activity map cannot be replaced with its prerequisite map", () => {
  const root = quest("抓紧胜利的王冠！"); const prerequisite = quest("前往游乐场");
  assert.equal(matchImageQuest(root.name, "", evidence(prerequisite), index).location, undefined);
  assert.equal(matchImageQuest(root.name, "", evidence(root), index).code, "verified");
});
test("mismatched, ambiguous and low-confidence coordinates retain an unknown map", () => {
  const root = quest("黑衣青年");
  for (const lines of [[line("X:8.5 Y:9.1"), line(root.npc!.name)],
    [line("X:8.5 Y:9.7", 59), line(root.npc!.name)],
    [...evidence(root), line("X:9.6 Y:9.0")]]) assert.equal(matchImageQuest(root.name, "", lines, index).location, undefined);
});
test("coordinates alone or another NPC/region are insufficient to choose the indexed map", () => {
  assert.equal(matchImageQuest("黑衣青年", "", [line("X:8.5 Y:9.7")], index).location, undefined);
  assert.equal(matchImageQuest("黑衣青年", "", [line("X:8.5 Y:9.7"), line("莱维娜 金碟游乐场")], index).location, undefined);
});
test("new names absent from the current game snapshot and repeated quest names stay unknown", () => {
  assert.equal(matchImageQuest("未来新任务", "", [], index).code, "quest_not_in_game_index");
  const duplicate = index.quests.find(root => index.quests.some(other => other.id !== root.id && other.name === root.name))!;
  assert.equal(matchImageQuest(duplicate.name, "", evidence(quest("黑衣青年")), index).code, "ambiguous_game_quest");
});
test("automatic completion follows the FF15 final achievement but never assumes every festival terminal is completion", () => {
  assert.deepEqual(automaticCompletion(quest("黑衣青年"), index), { questId: 68696, achievementId: 2241 });
  assert.deepEqual(automaticCompletion(quest("抓紧胜利的王冠！"), index), { questId: 70337 });
  assert.deepEqual(automaticCompletion(quest("前往游乐场"), index), {});
  assert.deepEqual(automaticCompletion(quest("新生庆典与音乐的轨迹"), index), {}, "optional follow-up after the main achievement must not delay hiding");
});
test("branches, repeats, unresolved descendants and broken graph links cannot become completion mappings", () => {
  const root = quest("黑衣青年");
  for (const changed of [{ ...root, nextQuestIds: [68695, 68696] }, { ...root, isRepeatable: true },
    { ...root, nextQuestIds: [999999] }]) assert.deepEqual(automaticCompletion(changed, { ...index, quests: [changed, ...index.quests.filter(quest => quest.id !== root.id)] }), {});
});
test("offline index validation rejects altered coordinates and duplicate ids", () => {
  const altered = structuredClone(raw); altered.quests.find((quest: IndexedQuest) => quest.name === "黑衣青年").location.x += 1;
  assert.throws(() => parseGameDataIndex(altered), /offline quest map/);
  const duplicate = structuredClone(raw); duplicate.quests.push(duplicate.quests[0]);
  assert.throws(() => parseGameDataIndex(duplicate), /offline quest/);
  const truncated = structuredClone(raw); truncated.quests.find((quest: IndexedQuest) => quest.id === 68694).nextQuestIds = [];
  assert.throws(() => parseGameDataIndex(truncated), /dependency graph/);
});
