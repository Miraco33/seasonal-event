import type { EventsDocument, SeasonalEvent } from "./models.js";

export function validateDocument(document: EventsDocument): void {
  if (document.schemaVersion !== 1 && document.schemaVersion !== 2) throw new Error("unsupported schemaVersion");
  if (!Number.isInteger(document.dataVersion) || document.dataVersion < 1 || document.dataVersion > 2147483647) throw new Error("invalid dataVersion");
  if (!isOffsetDateTime(document.publishedAt)) throw new Error("invalid publishedAt");
  if (!Array.isArray(document.events)) throw new Error("invalid events");

  const ids = new Set<string>();
  for (const event of document.events) validateEvent(event, ids, document.schemaVersion === 2);
  if (document.collectionStatus !== undefined) {
    const status = document.collectionStatus;
    if (!status || !["ok", "alert"].includes(status.status) || !status.code?.trim() ||
        (status.unavailableSources !== undefined && (!Array.isArray(status.unavailableSources) ||
          status.unavailableSources.some(url => !isHttpsUrl(url))))) {
      throw new Error("invalid collectionStatus");
    }
  }
}

function validateEvent(event: SeasonalEvent, ids: Set<string>, allowPartial: boolean): void {
  if (!event || typeof event !== "object") throw new Error("invalid event");
  if (typeof event.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(event.id)) throw new Error(`invalid event id: ${event.id}`);
  if (ids.has(event.id)) throw new Error(`duplicate event id: ${event.id}`);
  ids.add(event.id);
  if (typeof event.title !== "string" || !event.title.trim()) throw new Error(`missing required text: ${event.id}`);
  for (const value of [event.questName, event.questNpc]) {
    if (allowPartial && (value === null || value === undefined)) continue;
    if (typeof value !== "string" || !value.trim()) throw new Error(`missing required text: ${event.id}`);
  }
  if (event.questLevel !== undefined && event.questLevel !== null && (!Number.isInteger(event.questLevel) || event.questLevel <= 0 || event.questLevel > 2147483647)) {
    throw new Error(`invalid questLevel: ${event.id}`);
  }
  if (event.questId !== undefined && event.questId !== null && (!Number.isInteger(event.questId) || event.questId <= 0 || event.questId > 4294967295)) {
    throw new Error(`invalid questId: ${event.id}`);
  }
  if (event.achievementId !== undefined && event.achievementId !== null && (!Number.isInteger(event.achievementId) || event.achievementId <= 0 || event.achievementId > 4294967295)) {
    throw new Error(`invalid achievementId: ${event.id}`);
  }
  if (!isOffsetDateTime(event.startAt) || !isOffsetDateTime(event.endAt) || Date.parse(event.endAt) <= Date.parse(event.startAt)) {
    throw new Error(`invalid event window: ${event.id}`);
  }
  if (!allowPartial && !event.location) throw new Error(`missing location: ${event.id}`);
  if (event.location !== null && event.location !== undefined) {
    if (typeof event.location !== "object") throw new Error(`missing location: ${event.id}`);
    if (!Number.isInteger(event.location.territoryId) || event.location.territoryId <= 0 || event.location.territoryId > 4294967295) throw new Error(`invalid territory: ${event.id}`);
    if (!Number.isInteger(event.location.mapId) || event.location.mapId <= 0 || event.location.mapId > 4294967295) throw new Error(`invalid map: ${event.id}`);
    for (const coordinate of [event.location.x, event.location.y, event.location.z]) {
      if (!Number.isFinite(coordinate) || Math.abs(coordinate) > 100000) throw new Error(`invalid coordinate: ${event.id}`);
    }
    for (const coordinate of [event.location.displayX, event.location.displayY]) {
      if (coordinate !== undefined && coordinate !== null && (!Number.isFinite(coordinate) || Math.abs(coordinate) > 100000)) {
        throw new Error(`invalid display coordinate: ${event.id}`);
      }
    }
  }
  if (event.teleport !== undefined && event.teleport !== null) {
    if (!Number.isInteger(event.teleport.aetheryteId) || event.teleport.aetheryteId <= 0 || event.teleport.aetheryteId > 4294967295) throw new Error(`invalid teleport aetheryte: ${event.id}`);
    if (!Number.isInteger(event.teleport.subIndex) || event.teleport.subIndex < 0 || event.teleport.subIndex > 255) throw new Error(`invalid teleport subIndex: ${event.id}`);
  }
  if (!isHttpsUrl(event.sourceUrl)) throw new Error(`invalid sourceUrl: ${event.id}`);
  if (event.announcementUrl !== undefined) {
    const url = new URL(event.announcementUrl);
    if (url.protocol !== "https:" || url.hostname !== "cqnews.web.sdo.com" ||
        url.pathname !== "/api/news/newsDetail" || url.searchParams.get("gameCode") !== "ff" ||
        !/^\d+$/.test(url.searchParams.get("id") ?? "")) throw new Error(`invalid announcementUrl: ${event.id}`);
  }
  if (!isOffsetDateTime(event.lastVerifiedAt)) throw new Error(`invalid lastVerifiedAt: ${event.id}`);
  if (!Array.isArray(event.rewards) || (!allowPartial && event.rewards.length === 0)) throw new Error(`missing rewards: ${event.id}`);
  for (const reward of event.rewards) {
    if (!reward || !reward.name?.trim()) throw new Error(`empty reward: ${event.id}`);
    if (typeof reward.category !== "string" || typeof reward.description !== "string" ||
        !Array.isArray(reward.flags) || reward.flags.some(flag => typeof flag !== "string")) {
      throw new Error(`invalid reward: ${event.id}`);
    }
  }
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function isOffsetDateTime(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return Number(year) >= 1 && Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 &&
    (offsetHour === undefined || (Number(offsetHour) <= 14 && Number(offsetMinute) <= 59 &&
      (Number(offsetHour) !== 14 || Number(offsetMinute) === 0))) && Number.isFinite(Date.parse(value));
}
