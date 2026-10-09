import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseVerifiedQuestCatalogue } from "../dist/verified-quests.js";

const factsPath = process.argv[2] || "output/game-data-verification.json";
const facts = JSON.parse(await readFile(factsPath, "utf8"));
const cataloguePath = process.argv[3] || new URL("../config/verified-quests.json", import.meta.url);
const catalogue = parseVerifiedQuestCatalogue(JSON.parse(await readFile(cataloguePath, "utf8")));
assert.equal(facts.checksumMismatchPolicy, "fail");
assert.equal(facts.gameVersion, catalogue.gameVersion);
assert.equal(facts.language, catalogue.language);
for (const entry of catalogue.quests) {
  const group = facts.questGroups.find(group => group.requestedName === entry.questName);
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
  assert.deepEqual(entry.location, { territoryId: location.territoryId, mapId: location.mapId, ...location.world,
    displayX: location.officialDisplayComparison.x, displayY: location.officialDisplayComparison.y });
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
  console.log(`Game tables verified: ${entry.questName}, map ${entry.location.territoryId}/${entry.location.mapId}, completion ${entry.completion.questId}, ${entry.rewards?.length ?? 0} verified reward items`);
}
