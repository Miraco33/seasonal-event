import type { EventsDocument, SeasonalEvent } from "./models.js";

export function validateDocument(document: EventsDocument): void {
  if (document.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
  if (!Number.isInteger(document.dataVersion) || document.dataVersion < 1) throw new Error("invalid dataVersion");
  if (!isOffsetDateTime(document.publishedAt)) throw new Error("invalid publishedAt");
  if (!Array.isArray(document.events)) throw new Error("invalid events");

  const ids = new Set<string>();
  for (const event of document.events) validateEvent(event, ids);
}

function validateEvent(event: SeasonalEvent, ids: Set<string>): void {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(event.id)) throw new Error(`invalid event id: ${event.id}`);
  if (ids.has(event.id)) throw new Error(`duplicate event id: ${event.id}`);
  ids.add(event.id);
  if (!event.title?.trim() || !event.questName?.trim() || !event.questNpc?.trim()) throw new Error(`missing required text: ${event.id}`);
  if (event.questLevel !== undefined && event.questLevel !== null && (!Number.isInteger(event.questLevel) || event.questLevel <= 0)) {
    throw new Error(`invalid questLevel: ${event.id}`);
  }
  if (event.questId !== undefined && event.questId !== null && (!Number.isInteger(event.questId) || event.questId <= 0)) {
    throw new Error(`invalid questId: ${event.id}`);
  }
  if (event.achievementId !== undefined && event.achievementId !== null && (!Number.isInteger(event.achievementId) || event.achievementId <= 0)) {
    throw new Error(`invalid achievementId: ${event.id}`);
  }
  if (!isOffsetDateTime(event.startAt) || !isOffsetDateTime(event.endAt) || Date.parse(event.endAt) <= Date.parse(event.startAt)) {
    throw new Error(`invalid event window: ${event.id}`);
  }
  if (!event.location || typeof event.location !== "object") throw new Error(`missing location: ${event.id}`);
  if (!Number.isInteger(event.location.territoryId) || event.location.territoryId <= 0) throw new Error(`invalid territory: ${event.id}`);
  if (!Number.isInteger(event.location.mapId) || event.location.mapId <= 0) throw new Error(`invalid map: ${event.id}`);
  for (const coordinate of [event.location.x, event.location.y, event.location.z]) {
    if (!Number.isFinite(coordinate) || Math.abs(coordinate) > 100000) throw new Error(`invalid coordinate: ${event.id}`);
  }
  for (const coordinate of [event.location.displayX, event.location.displayY]) {
    if (coordinate !== undefined && coordinate !== null && (!Number.isFinite(coordinate) || Math.abs(coordinate) > 100000)) {
      throw new Error(`invalid display coordinate: ${event.id}`);
    }
  }
  if (event.teleport !== undefined && event.teleport !== null) {
    if (!Number.isInteger(event.teleport.aetheryteId) || event.teleport.aetheryteId <= 0) throw new Error(`invalid teleport aetheryte: ${event.id}`);
    if (!Number.isInteger(event.teleport.subIndex) || event.teleport.subIndex < 0 || event.teleport.subIndex > 255) throw new Error(`invalid teleport subIndex: ${event.id}`);
  }
  if (!/^https:\/\//.test(event.sourceUrl)) throw new Error(`invalid sourceUrl: ${event.id}`);
  if (!isOffsetDateTime(event.lastVerifiedAt)) throw new Error(`invalid lastVerifiedAt: ${event.id}`);
  if (!Array.isArray(event.rewards) || event.rewards.length === 0) throw new Error(`missing rewards: ${event.id}`);
  for (const reward of event.rewards) {
    if (!reward || !reward.name?.trim()) throw new Error(`empty reward: ${event.id}`);
    if (typeof reward.category !== "string" || typeof reward.description !== "string" ||
        !Array.isArray(reward.flags) || reward.flags.some(flag => typeof flag !== "string")) {
      throw new Error(`invalid reward: ${event.id}`);
    }
  }
}

function isOffsetDateTime(value: string): boolean {
  return typeof value === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
