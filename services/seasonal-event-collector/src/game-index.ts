import type { EventLocation, EventReward } from "./models.js";
import { imageCoordinates, type OcrLine } from "./image-ocr.js";
import { worldToDisplay } from "./verified-quests.js";

export interface IndexedQuest {
  id: number; name: string; normalizedName: string;
  npc: { id: number; name: string } | null;
  minLevel: number | null;
  location: (EventLocation & { levelId: number; mapX: number; mapY: number;
    mapTransform: { sizeFactor: number; offsetX: number; offsetY: number };
    mapNames: { map: string; territory: string } }) | null;
  previousQuestIds: number[]; previousQuestJoin: number; nextQuestIds: number[];
  festivalId: number; festivalName: string | null; journalGenreId: number; journalGenreName: string | null;
  isRepeatable: boolean; achievementIds: number[];
  rewardItems: Array<{ id: number; name: string; count: number | null; optional: boolean;
    category?: string | null; description?: string; flags?: string[] }>;
}
export interface GameDataIndex {
  schemaVersion: 1; gameVersion: string; language: "ChineseSimplified"; verifiedAt: string;
  checksumMismatchPolicy: "fail"; normalization: "NFKC/remove-whitespace/lowercase";
  quests: IndexedQuest[];
  achievements: Array<{ id: number; name: string; description: string; type: number; keyQuestId: number | null; questIds: number[] }>;
}
export interface AutomaticQuestDetails {
  npc?: string; level?: number; location?: EventLocation;
  completion: { questId?: number; achievementId?: number };
  rewards: EventReward[];
  code: "verified" | "quest_not_in_game_index" | "ambiguous_game_quest" | "image_map_not_verified";
}

export function normalizeGameText(value: string): string {
  return value.normalize("NFKC").replace(/[\s·・]/g, "").toLowerCase();
}

export function parseGameDataIndex(value: unknown): GameDataIndex {
  if (!record(value) || value.schemaVersion !== 1 || value.language !== "ChineseSimplified" ||
      value.checksumMismatchPolicy !== "fail" || value.normalization !== "NFKC/remove-whitespace/lowercase" ||
      typeof value.gameVersion !== "string" || !value.gameVersion.trim() ||
      typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt)) ||
      !Array.isArray(value.quests) || value.quests.length === 0 || value.quests.length > 30000 || !Array.isArray(value.achievements)) {
    throw new Error("invalid offline game index header");
  }
  const ids = new Set<number>();
  for (const raw of value.quests) {
    if (!record(raw)) throw new Error("invalid offline quest");
    const quest = raw as unknown as IndexedQuest;
    if (!uint(quest.id) || ids.has(quest.id) || typeof quest.name !== "string" || !quest.name.trim() ||
        typeof quest.normalizedName !== "string" ||
        !Array.isArray(quest.previousQuestIds) || quest.previousQuestIds.some(id => !uint(id)) ||
        !Array.isArray(quest.nextQuestIds) || quest.nextQuestIds.some(id => !uint(id)) ||
        !Number.isInteger(quest.previousQuestJoin) || !nonnegative(quest.festivalId) || !nonnegative(quest.journalGenreId) ||
        typeof quest.isRepeatable !== "boolean" || !Array.isArray(quest.achievementIds) || quest.achievementIds.some(id => !uint(id)) ||
        !Array.isArray(quest.rewardItems) || quest.rewardItems.some(item => !record(item) || !uint(item.id) || typeof item.name !== "string") ||
        (quest.npc !== null && (!record(quest.npc) || !uint(quest.npc.id) || typeof quest.npc.name !== "string")) ||
        (quest.minLevel !== null && (!uint(quest.minLevel) || quest.minLevel > 100))) throw new Error(`invalid offline quest: ${quest.id}`);
    ids.add(quest.id);
    const location = quest.location;
    if (location !== null) {
      if (!record(location) || !uint(location.mapId) || !uint(location.territoryId) || !uint(location.levelId) ||
          [location.x, location.y, location.z, location.displayX, location.displayY, location.mapX, location.mapY].some(number => !Number.isFinite(number)) ||
          !record(location.mapTransform) || !Number.isFinite(location.mapTransform.sizeFactor) || location.mapTransform.sizeFactor <= 0 ||
          !Number.isFinite(location.mapTransform.offsetX) || !Number.isFinite(location.mapTransform.offsetY) ||
          !record(location.mapNames) || typeof location.mapNames.map !== "string" || typeof location.mapNames.territory !== "string" ||
          Math.abs(worldToDisplay(location.x, location.mapTransform.sizeFactor, location.mapTransform.offsetX) - location.displayX!) > 0.00001 ||
          Math.abs(worldToDisplay(location.z, location.mapTransform.sizeFactor, location.mapTransform.offsetY) - location.displayY!) > 0.00001 ||
          Math.floor(location.displayX! * 10) / 10 !== location.mapX || Math.floor(location.displayY! * 10) / 10 !== location.mapY) {
        throw new Error(`invalid offline quest map: ${quest.id}`);
      }
    }
  }
  for (const achievement of value.achievements) {
    if (!record(achievement) || !uint(achievement.id) || !Array.isArray(achievement.questIds) || achievement.questIds.some(id => !uint(id))) {
      throw new Error("invalid offline quest achievement");
    }
  }
  const quests = value.quests as unknown as IndexedQuest[];
  const byId = new Map(quests.map(quest => [quest.id, quest]));
  for (const quest of quests) {
    if (quest.previousQuestIds.some(previous => byId.has(previous) && !byId.get(previous)!.nextQuestIds.includes(quest.id)) ||
        quest.nextQuestIds.some(next => byId.has(next) && !byId.get(next)!.previousQuestIds.includes(quest.id))) {
      throw new Error(`inconsistent offline quest dependency graph: ${quest.id}`);
    }
    for (const achievementId of quest.achievementIds) {
      if (!(value.achievements as GameDataIndex["achievements"]).some(achievement => achievement.id === achievementId && achievement.keyQuestId === quest.id)) {
        throw new Error(`inconsistent offline quest achievement link: ${quest.id}`);
      }
    }
  }
  return value as unknown as GameDataIndex;
}

export function matchImageQuest(questName: string | null, text: string, lines: OcrLine[], index: GameDataIndex): AutomaticQuestDetails {
  const empty = (code: AutomaticQuestDetails["code"]): AutomaticQuestDetails => ({ completion: {}, rewards: [], code });
  if (!questName) return empty("quest_not_in_game_index");
  const candidates = index.quests.filter(quest => normalizeGameText(quest.name) === normalizeGameText(questName));
  if (candidates.length === 0) return empty("quest_not_in_game_index");
  // A repeated name is not enough evidence to choose one game row.
  if (candidates.length !== 1) return empty("ambiguous_game_quest");
  const quest = candidates[0]; const location = quest.location;
  if (!location || !quest.npc?.name) return empty("image_map_not_verified");
  const coordinates = imageCoordinates(lines);
  // Multiple different coordinate pairs in one task block are ambiguous even
  // when one happens to agree with the game table (prerequisites are common).
  if (coordinates.length !== 1 || Math.abs(coordinates[0].x - location.mapX) > 0.001 ||
      Math.abs(coordinates[0].y - location.mapY) > 0.001) return empty("image_map_not_verified");
  const confidentText = normalizeGameText(text + "\n" + lines.filter(line => line.confidence >= 50).map(line => line.text).join("\n"));
  const npcMatched = confidentText.includes(normalizeGameText(quest.npc.name));
  const mapMatched = [location.mapNames.map, location.mapNames.territory]
    .some(name => name.trim().length >= 3 && confidentText.includes(normalizeGameText(name)));
  if (!npcMatched && !mapMatched) return empty("image_map_not_verified");
  const completion = automaticCompletion(quest, index);
  const observedRewards = quest.rewardItems.filter(item => normalizeGameText(item.name).length >= 3 &&
    lines.some(line => line.confidence >= 65 && normalizeGameText(line.text).includes(normalizeGameText(item.name))))
    .map(item => ({ name: item.name, category: item.category ?? "", description: item.description ?? "", flags: item.flags ?? [] }));
  return { npc: quest.npc.name, ...(quest.minLevel ? { level: quest.minLevel } : {}),
    location: { territoryId: location.territoryId, mapId: location.mapId, x: location.x, y: location.y, z: location.z,
      displayX: location.mapX, displayY: location.mapY }, completion, rewards: observedRewards, code: "verified" };
}

export function automaticCompletion(root: IndexedQuest, index: GameDataIndex): AutomaticQuestDetails["completion"] {
  if (!root.festivalId || root.isRepeatable) return {};
  if (index.quests.some(candidate => candidate.previousQuestIds.includes(root.id) && !root.nextQuestIds.includes(candidate.id))) return {};
  const byId = new Map(index.quests.map(quest => [quest.id, quest]));
  const visited = new Set<number>();
  const stages: IndexedQuest[] = [];
  let terminal = root;
  while (true) {
    if (visited.has(terminal.id) || visited.size >= 64 || terminal.isRepeatable) return {};
    visited.add(terminal.id);
    stages.push(terminal);
    if (terminal.nextQuestIds.length === 0) break;
    if (terminal.nextQuestIds.length !== 1) return {};
    const next = byId.get(terminal.nextQuestIds[0]);
    if (!next || next.festivalId !== root.festivalId || next.journalGenreId !== root.journalGenreId ||
        next.previousQuestIds.length !== 1 || next.previousQuestIds[0] !== terminal.id) return {};
    terminal = next;
  }
  const achievements = index.achievements.filter(achievement => achievement.type === 6 && achievement.keyQuestId === terminal.id &&
    achievement.questIds.length === 1 && achievement.questIds[0] === terminal.id && terminal.achievementIds.includes(achievement.id));
  // Optional follow-up quests can share a festival/category with the main
  // quest. Only use a multi-stage terminal when a direct completion achievement
  // supports it and no earlier stage has another completion achievement.
  if (stages.length > 1 && (achievements.length !== 1 || stages.slice(0, -1).some(stage =>
    index.achievements.some(achievement => achievement.type === 6 && achievement.keyQuestId === stage.id)))) return {};
  return { questId: terminal.id, ...(achievements.length === 1 ? { achievementId: achievements[0].id } : {}) };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function uint(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4294967295; }
function nonnegative(value: unknown): value is number { return value === 0 || uint(value); }
