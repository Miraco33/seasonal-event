import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const [indexPath, factsPath] = process.argv.slice(2);
assert.ok(indexPath, 'Usage: node verify-index.mjs <index.json> [verification-report.json]');
const bytes = readFileSync(indexPath);
assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf', 'Index must be UTF-8 without BOM');
assert.ok(!bytes.includes(13) && bytes.at(-1) === 10, 'Index must use LF with a terminal newline');
const index = JSON.parse(bytes.toString('utf8'));
assert.equal(index.schemaVersion, 1);
assert.equal(index.language, 'ChineseSimplified');
assert.equal(index.checksumMismatchPolicy, 'fail');
assert.equal(index.normalization, 'NFKC/remove-whitespace/lowercase');
assert.ok(index.gameVersion && Number.isFinite(Date.parse(index.verifiedAt)));
const byId = new Map(index.quests.map(quest => [quest.id, quest]));
assert.equal(byId.size, index.quests.length, 'Quest IDs must be unique');
const achievements = new Map(index.achievements.map(achievement => [achievement.id, achievement]));
assert.equal(achievements.size, index.achievements.length, 'Achievement IDs must be unique');
for (const achievement of achievements.values()) {
  assert.ok(achievement.questIds.every(id => byId.has(id)), 'Achievement refers to an unknown named task');
  if (achievement.keyQuestId !== null) assert.ok(achievement.questIds.includes(achievement.keyQuestId));
}
let maxError = 0;
for (const quest of index.quests) {
  assert.equal(quest.normalizedName, quest.name.normalize('NFKC').replace(/\p{White_Space}/gu, '').toLowerCase());
  for (const childId of quest.nextQuestIds) {
    const child = byId.get(childId);
    if (child) assert.ok(child.previousQuestIds.includes(quest.id), `Missing reciprocal predecessor for ${childId}`);
  }
  for (const previousId of quest.previousQuestIds) {
    const previous = byId.get(previousId);
    if (previous) assert.ok(previous.nextQuestIds.includes(quest.id), `Missing reciprocal successor for ${previousId}`);
  }
  for (const achievementId of quest.achievementIds) {
    assert.equal(achievements.get(achievementId)?.keyQuestId, quest.id, 'Direct achievement must have a real Quest key');
  }
  for (const reward of quest.rewardItems) {
    assert.ok(Number.isInteger(reward.id) && reward.id > 0 && reward.name);
    assert.ok(reward.count === null || (Number.isInteger(reward.count) && reward.count >= 0));
    assert.equal(typeof reward.optional, 'boolean');
    assert.ok(reward.flags.every(flag => ['isUnique', 'isUntradable', 'isIndisposable'].includes(flag)));
  }
  if (quest.location === null) continue;
  const location = quest.location;
  const transform = location.mapTransform;
  assert.ok(transform.sizeFactor > 0 && location.mapId > 0 && location.territoryId > 0);
  for (const field of ['x', 'y', 'z', 'displayX', 'displayY', 'mapX', 'mapY']) assert.ok(Number.isFinite(location[field]));
  const x = (location.displayX - 1) * 2048 / 41 - 1024 / (transform.sizeFactor / 100) - transform.offsetX;
  const z = (location.displayY - 1) * 2048 / 41 - 1024 / (transform.sizeFactor / 100) - transform.offsetY;
  const error = Math.max(Math.abs(x - location.x), Math.abs(z - location.z));
  assert.ok(error < 0.000001, `Coordinate inverse mismatch for ${quest.id}`);
  maxError = Math.max(maxError, error);
  assert.equal(location.mapX, Math.floor(location.displayX * 10) / 10);
  assert.equal(location.mapY, Math.floor(location.displayY * 10) / 10);
}
if (factsPath) {
  const facts = JSON.parse(readFileSync(factsPath, 'utf8'));
  assert.equal(index.gameVersion, facts.gameVersion);
  assert.equal(index.language, facts.language);
  for (const group of facts.questGroups) {
    for (const expected of group.quests) {
      const actual = byId.get(expected.rowId);
      assert.ok(actual, `Missing verified task ${expected.rowId}`);
      assert.equal(actual.name, expected.name);
      assert.equal(actual.npc?.id ?? null, expected.issuerNpc ? expected.issuerId : null);
      assert.equal(actual.npc?.name ?? null, expected.issuerNpc);
      assert.deepEqual(actual.previousQuestIds, expected.previousQuests.map(previous => previous.rowId));
      assert.equal(actual.previousQuestJoin, expected.previousQuestJoin);
      assert.equal(actual.festivalId, expected.festivalId);
      assert.equal(actual.journalGenreId, expected.journalGenreId);
      assert.equal(actual.isRepeatable, expected.isRepeatable);
      assert.equal(actual.minLevel, expected.classJobLevels.length ? Math.min(...expected.classJobLevels) : null);
      if (!expected.issuerLocation) { assert.equal(actual.location, null); continue; }
      const location = expected.issuerLocation;
      assert.equal(actual.location.mapId, location.mapId);
      assert.equal(actual.location.territoryId, location.territoryId);
      // The older report serializes float shortest decimals; the index keeps the exact float value as a double.
      for (const coordinate of ['x', 'y', 'z']) assert.ok(Math.abs(actual.location[coordinate] - location.world[coordinate]) < 0.0001);
      assert.deepEqual(actual.location.mapTransform, { sizeFactor: location.sizeFactor, offsetX: location.offsetX, offsetY: location.offsetY });
    }
  }
}
console.log(JSON.stringify({ ok: true, quests: byId.size, achievements: achievements.size, bytes: bytes.length, maximumRoundtripError: maxError }));
