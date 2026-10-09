import type { EventLocation, EventReward } from "./models.js";

export interface VerifiedQuestDefinition {
  questName: string;
  sourcePathKeywords: string[];
  startQuestId: number;
  questNpc: string;
  questLevel: number;
  location: EventLocation;
  mapTransform: { sizeFactor: number; offsetX: number; offsetY: number };
  completion: { questId: number; achievementId?: number };
  questChain: Array<{ questId: number; questName: string; previousQuestIds: number[] }>;
  rewards?: EventReward[];
  evidence: {
    issuerNpcId: number;
    issuerLocationId: number;
    terminalQuestId: number;
    officialSources: string[];
    rewardItemIds?: number[];
    completionAchievementQuestId?: number;
  };
}

export interface VerifiedQuestCatalogue {
  schemaVersion: 1;
  gameVersion: string;
  language: "ChineseSimplified";
  verifiedAt: string;
  quests: VerifiedQuestDefinition[];
}

export function resolveVerifiedQuest(
  questName: string | null,
  sourceUrl: string,
  catalogue: VerifiedQuestDefinition[] = [],
): VerifiedQuestDefinition | undefined {
  if (!questName) return undefined;
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:" || url.hostname !== "actff1.web.sdo.com") return undefined;
  const path = url.pathname.toLowerCase();
  const matches = catalogue.filter(quest => normalizeQuestName(quest.questName) === normalizeQuestName(questName) &&
    quest.sourcePathKeywords.some(keyword => path.includes(keyword.toLowerCase())));
  if (matches.length > 1) throw new Error(`ambiguous verified quest mapping: ${questName}`);
  return matches[0];
}

export function worldToDisplay(world: number, sizeFactor: number, offset: number): number {
  const scale = sizeFactor / 100;
  return 41 / scale * (((world + offset) * scale + 1024) / 2048) + 1;
}

export function displayToWorld(display: number, sizeFactor: number, offset: number): number {
  const scale = sizeFactor / 100;
  return (((display - 1) * scale / 41 * 2048) - 1024) / scale - offset;
}

export function parseVerifiedQuestCatalogue(value: unknown): VerifiedQuestCatalogue {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.language !== "ChineseSimplified" ||
      typeof value.gameVersion !== "string" || !value.gameVersion.trim() ||
      typeof value.verifiedAt !== "string" || !Number.isFinite(Date.parse(value.verifiedAt)) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.verifiedAt) || !Array.isArray(value.quests)) {
    throw new Error("invalid verified quest catalogue header");
  }
  const identities = new Set<string>();
  for (const raw of value.quests) {
    if (!isRecord(raw)) throw new Error("invalid verified quest entry");
    const quest = raw as unknown as VerifiedQuestDefinition;
    if (!text(quest.questName) || !text(quest.questNpc) || !uint(quest.startQuestId) ||
        !Number.isInteger(quest.questLevel) || quest.questLevel < 1 || quest.questLevel > 2147483647 ||
        !Array.isArray(quest.sourcePathKeywords) || quest.sourcePathKeywords.length === 0 ||
        quest.sourcePathKeywords.some(keyword => !text(keyword) || keyword.trim().length < 3)) {
      throw new Error("invalid verified quest identity");
    }
    for (const keyword of quest.sourcePathKeywords) {
      const identity = `${normalizeQuestName(quest.questName)}:${keyword.toLowerCase()}`;
      if (identities.has(identity)) throw new Error(`duplicate verified quest scope: ${quest.questName}`);
      identities.add(identity);
    }
    const location = quest.location;
    const transform = quest.mapTransform;
    if (!isRecord(location) || !uint(location.territoryId) || !uint(location.mapId) ||
        [location.x, location.y, location.z].some(coordinate => !Number.isFinite(coordinate) || Math.abs(coordinate) > 100000) ||
        !isRecord(transform) || !Number.isFinite(transform.sizeFactor) || transform.sizeFactor <= 0 ||
        !Number.isFinite(transform.offsetX) || !Number.isFinite(transform.offsetY) ||
        !Number.isFinite(location.displayX) || !Number.isFinite(location.displayY)) {
      throw new Error(`invalid verified quest map: ${quest.questName}`);
    }
    const calculatedX = Math.floor(worldToDisplay(location.x, transform.sizeFactor, transform.offsetX) * 10) / 10;
    const calculatedY = Math.floor(worldToDisplay(location.z, transform.sizeFactor, transform.offsetY) * 10) / 10;
    if (Math.abs(calculatedX - location.displayX!) > 0.000001 || Math.abs(calculatedY - location.displayY!) > 0.000001) {
      throw new Error(`verified world coordinates disagree with official display coordinates: ${quest.questName}`);
    }
    const chain = quest.questChain;
    if (!isRecord(quest.completion) || !uint(quest.completion.questId) ||
        (quest.completion.achievementId !== undefined && !uint(quest.completion.achievementId)) ||
        !Array.isArray(chain) || chain.length === 0 || chain.length > 64 ||
        chain[0]?.questId !== quest.startQuestId || normalizeQuestName(chain[0]?.questName ?? "") !== normalizeQuestName(quest.questName) ||
        chain[chain.length - 1]?.questId !== quest.completion.questId) {
      throw new Error(`invalid verified quest completion chain: ${quest.questName}`);
    }
    const chainIds = new Set<number>();
    chain.forEach((stage, index) => {
      if (!isRecord(stage) || !uint(stage.questId) || !text(stage.questName) || chainIds.has(stage.questId) ||
          !Array.isArray(stage.previousQuestIds) || stage.previousQuestIds.some(id => !uint(id)) ||
          (index > 0 && !stage.previousQuestIds.includes(chain[index - 1].questId))) {
        throw new Error(`broken verified quest dependency chain: ${quest.questName}`);
      }
      chainIds.add(stage.questId);
    });
    const evidence = quest.evidence;
    if (!isRecord(evidence) || !uint(evidence.issuerNpcId) || !uint(evidence.issuerLocationId) ||
        !uint(evidence.terminalQuestId) || evidence.terminalQuestId !== quest.completion.questId ||
        !Array.isArray(evidence.officialSources) || evidence.officialSources.length === 0 ||
        evidence.officialSources.some(source => !officialUrl(source)) ||
        (quest.completion.achievementId !== undefined && evidence.completionAchievementQuestId !== quest.completion.questId)) {
      throw new Error(`missing verified quest evidence: ${quest.questName}`);
    }
    if (quest.rewards !== undefined && (!Array.isArray(quest.rewards) || quest.rewards.some(reward =>
        !isRecord(reward) || !text(reward.name) || typeof reward.category !== "string" || typeof reward.description !== "string" ||
        !Array.isArray(reward.flags) || reward.flags.some(flag => typeof flag !== "string")) ||
        !Array.isArray(evidence.rewardItemIds) || evidence.rewardItemIds.length !== quest.rewards.length ||
        evidence.rewardItemIds.some(id => !uint(id)) || new Set(evidence.rewardItemIds).size !== evidence.rewardItemIds.length)) {
      throw new Error(`invalid verified quest rewards: ${quest.questName}`);
    }
  }
  return value as unknown as VerifiedQuestCatalogue;
}

function normalizeQuestName(value: string): string { return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase(); }
function uint(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4294967295; }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function officialUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "https:" && ["actff1.web.sdo.com", "static.web.sdo.com"].includes(url.hostname); }
  catch { return false; }
}
