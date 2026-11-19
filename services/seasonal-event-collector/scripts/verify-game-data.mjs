import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { automaticCompletion, parseGameDataIndex } from "../dist/game-index.js";
import { parseVerifiedQuestCatalogue } from "../dist/verified-quests.js";

const factsPath = process.argv[2] || "output/game-data-verification.json";
const facts = JSON.parse(await readFile(factsPath, "utf8"));
const cataloguePath = process.argv[3] || new URL("../config/verified-quests.json", import.meta.url);
const catalogue = parseVerifiedQuestCatalogue(JSON.parse(await readFile(cataloguePath, "utf8")));
assert.equal(facts.checksumMismatchPolicy, "fail");
assert.equal(facts.gameVersion, catalogue.gameVersion);
assert.equal(facts.language, catalogue.language);
let index;
for (const entry of catalogue.quests) {
  const group = facts.questGroups.find(group => group.requestedName === entry.questName);
  if (!group && entry.evidence.officialDisplay) {
    if (!index) {
      index = parseGameDataIndex(JSON.parse(await readFile(new URL("../config/game-quest-index.json", import.meta.url), "utf8")));
      assert.equal(index.gameVersion, catalogue.gameVersion);
      assert.equal(index.language, catalogue.language);
    }
    verifyIndexedQuest(entry, index);
    logVerifiedQuest(entry);
    continue;
  }
  assert.ok(group, `missing offline quest evidence: ${entry.questName}`);
  assert.equal(group.exactMatchCount, 1);
  assert.ok(group.terminalQuestCandidates.some(quest => quest.rowId === entry.completion.questId),
    `completion must be an independently extracted terminal game quest: ${entry.questName}`);
  const first = group.quests.find(quest => quest.rowId === entry.startQuestId);
  assert.ok(first);
  assert.equal(entry.questNpc, first.issuerNpc);
  assert.equal(entry.questLevel, Math.min(...first.classJobLevels));
  assert.equal(entry.evidence.issuerNpcId, first.issuerId);
  assert.equal(entry.evidence.issuerLocationId, first.issuerLocation.levelId);
  const location = first.issuerLocation;
  if (entry.evidence.officialDisplay) {
    verifyLocation(entry.location, { territoryId: location.territoryId, mapId: location.mapId, ...location.world,
      displayX: location.display.floorX, displayY: location.display.floorY });
    if (location.officialDisplayComparison) {
      assert.deepEqual(entry.evidence.officialDisplay, { x: location.officialDisplayComparison.x, y: location.officialDisplayComparison.y });
    }
  } else {
    assert.deepEqual(entry.location, { territoryId: location.territoryId, mapId: location.mapId, ...location.world,
      displayX: location.officialDisplayComparison.x, displayY: location.officialDisplayComparison.y });
  }
  assert.deepEqual(entry.mapTransform, { sizeFactor: location.sizeFactor, offsetX: location.offsetX, offsetY: location.offsetY });
  for (const stage of entry.questChain) {
    const quest = group.quests.find(quest => quest.rowId === stage.questId);
    assert.ok(quest, `missing dependency evidence: ${stage.questId}`);
    assert.equal(stage.questName, quest.name);
    assert.deepEqual(stage.previousQuestIds, quest.previousQuests.map(previous => previous.rowId));
  }
  if (entry.completion.achievementId !== undefined) {
    const achievement = facts.matchingAchievements.find(achievement => achievement.rowId === entry.completion.achievementId);
    assert.equal(achievement?.key.rowType, "Quest");
    assert.equal(achievement?.key.rowId, entry.completion.questId);
  }
  for (let index = 0; index < (entry.rewards?.length ?? 0); index++) {
    const reward = entry.rewards[index];
    const itemGroup = facts.itemGroups.find(group => group.requestedName === reward.name);
    assert.equal(itemGroup?.exactMatchCount, 1, `ambiguous or unknown item: ${reward.name}`);
    const item = itemGroup.items[0];
    assert.equal(entry.evidence.rewardItemIds[index], item.rowId);
    assert.equal(reward.category, item.category);
    assert.equal(reward.description, item.description);
    assert.deepEqual(reward.flags, [...(item.isUnique ? ["唯一持有"] : []), ...(item.isUntradable ? ["不可交易"] : []), ...(item.isIndisposable ? ["不可丢弃"] : [])]);
  }
  logVerifiedQuest(entry);
}

function verifyIndexedQuest(entry, index) {
  assert.ok(!entry.rewards?.length, `reward verification requires a detailed offline report: ${entry.questName}`);
  const roots = index.quests.filter(quest => quest.name === entry.questName);
  assert.equal(roots.length, 1, `expected one indexed quest: ${entry.questName}`);
  const [first] = roots;
  assert.equal(entry.startQuestId, first.id);
  assert.equal(entry.questNpc, first.npc?.name);
  assert.equal(entry.questLevel, first.minLevel);
  assert.equal(entry.evidence.issuerNpcId, first.npc?.id);
  assert.equal(entry.evidence.issuerLocationId, first.location?.levelId);
  const { territoryId, mapId, x, y, z, mapX, mapY, mapTransform } = first.location;
  verifyLocation(entry.location, { territoryId, mapId, x, y, z, displayX: mapX, displayY: mapY });
  assert.deepEqual(entry.mapTransform, mapTransform);
  for (const stage of entry.questChain) {
    const quest = index.quests.find(quest => quest.id === stage.questId);
    assert.ok(quest, `missing indexed dependency evidence: ${stage.questId}`);
    assert.equal(stage.questName, quest.name);
    assert.deepEqual(stage.previousQuestIds, quest.previousQuestIds);
  }
  assert.deepEqual(entry.completion, automaticCompletion(first, index));
}

function verifyLocation(expected, fromGame) {
  // The raw report and index serialize the same single-precision game coordinates differently.
  const withGamePrecision = ({ x, y, z, ...location }) => ({ ...location, x: Math.fround(x), y: Math.fround(y), z: Math.fround(z) });
  assert.deepEqual(withGamePrecision(expected), withGamePrecision(fromGame));
}

function logVerifiedQuest(entry) {
  console.log(`Game tables verified: ${entry.questName}, map ${entry.location.territoryId}/${entry.location.mapId}, completion ${entry.completion.questId}, ${entry.rewards?.length ?? 0} verified reward items`);
}
