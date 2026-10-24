import assert from "node:assert/strict";
import test from "node:test";
import { collectAutomaticEvents, legacyEvents } from "./collection.js";
import { parseConditionalTimeWindow, parseTimeWindow } from "./source.js";
import { hasPublicationChanges } from "./publisher.js";
import { validateDocument } from "./validate.js";
import type { EventsDocument, PendingSeasonalEvent, SeasonalEvent } from "./models.js";
import type { CollectorConfiguration } from "./configuration.js";

const url = "https://actff1.web.sdo.com/project/new-crossover/index.html";
const news = "https://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=394486";
const now = new Date("2026-10-25T00:00:00+08:00");
const pending: PendingSeasonalEvent = { id: "new-crossover", title: "新的游戏内联动", startAt: "2026-10-28T16:00:00+08:00",
  endCondition: "8.0版本更新维护前", questName: null, questLevel: null, questNpc: null, questId: null,
  location: null, achievementId: null, rewards: [], sourceUrl: url, announcementUrl: news, lastVerifiedAt: now.toISOString() };
const config: CollectorConfiguration = { configFile: "unused", approvedSourceUrls: [], discoveryUrls: [], pendingCandidateUrls: [],
  ignoredCandidateUrls: [], allowedCandidateHosts: ["actff1.web.sdo.com"], eventIds: {}, overrides: { locations: {}, rewards: {}, completion: {} } };
const candidate = { url, title: pending.title, discoveredFrom: news, announcementUrl: news,
  sourceType: "discovered" as const, matchedKeywords: ["联动"], reviewStatus: "pending" as const,
  announcementText: "活动时间：2026年10月28日16:00～8.0版本更新维护前" };
const document = (): EventsDocument => ({ schemaVersion: 2, dataVersion: 1, publishedAt: now.toISOString(), events: [],
  pendingEvents: [{ ...pending }], collectionStatus: { status: "alert", code: "candidate_review_required" } });

test("official maintenance conditions preserve the start and exact condition without inventing an end timestamp", () => {
  assert.deepEqual(parseConditionalTimeWindow(candidate.announcementText), { startAt: pending.startAt, endCondition: pending.endCondition });
  assert.deepEqual(parseConditionalTimeWindow("2027年2月3日12:30 ～ 9.1 版本维护前"),
    { startAt: "2027-02-03T12:30:00+08:00", endCondition: "9.1版本维护前" });
  assert.equal(parseTimeWindow(candidate.announcementText), null);
  assert.equal(parseConditionalTimeWindow("2026年2月30日16:00～8.0版本维护前"), null);
  assert.equal(parseConditionalTimeWindow("2026年10月28日16:00～2026年11月10日22:59"), null);
});

test("pending records cannot weaken normal event windows or suppress the old-client alert", () => {
  assert.doesNotThrow(() => validateDocument(document()));
  assert.throws(() => validateDocument({ ...document(), schemaVersion: 1 }));
  assert.throws(() => validateDocument({ ...document(), collectionStatus: { status: "ok", code: "healthy" } }));
  assert.throws(() => validateDocument({ ...document(), pendingEvents: [{ ...pending, endCondition: " " }] }));
  assert.throws(() => validateDocument({ ...document(), pendingEvents: [{ ...pending, endAt: "2026-12-01T00:00:00+08:00" } as unknown as PendingSeasonalEvent] }));
  assert.throws(() => validateDocument({ ...document(), events: [pending as unknown as SeasonalEvent] }));
});

test("IDs remain unique across normal and pending records", () => {
  const { endCondition: _, ...details } = pending;
  const full = { ...details, endAt: "2026-12-01T00:00:00+08:00" };
  assert.throws(() => validateDocument({ ...document(), events: [full] }));
});

test("a successfully read unknown deadline is published as pending and reviewed, not reported as a fetch failure", async () => {
  const result = await collectAutomaticEvents(config, [candidate], undefined, now, {}, {
    fetch: async () => Response.json({ Code: "0", Data: { Title: pending.title, Content: candidate.announcementText } }),
    collect: async (_, options) => {
      assert.deepEqual(Object.values(options.conditionalTimeFallbacks ?? {}), [{ startAt: pending.startAt, endCondition: pending.endCondition }]);
      options.onPendingEvent?.(pending); return [];
    },
  });
  assert.deepEqual(result.events, []); assert.equal(result.failures.length, 0);
  assert.equal(result.pendingEvents.length, 1);
  assert.deepEqual(result.reviewCandidates[0].reviewGaps, ["end_time_not_announced"]);
  assert.equal(result.reviewCandidates[0].knownStartAt, pending.startAt);
  assert.equal(result.reviewCandidates[0].officialEndCondition, pending.endCondition);
});

test("pending activities remain observed and failed refreshes retain their original verification time", async () => {
  const result = await collectAutomaticEvents(config, [], document(), new Date("2026-10-27T00:00:00+08:00"), { attempts: 1 }, {
    fetch: async () => new Response("unavailable", { status: 503 }),
    collect: async () => { throw new Error("must not read the page using a failed announcement"); },
  });
  assert.equal(result.pendingEvents.length, 1);
  assert.equal(result.pendingEvents[0].lastVerifiedAt, pending.lastVerifiedAt);
  assert.equal(result.failures.length, 1);
  assert.equal(result.reviewCandidates[0].officialEndCondition, pending.endCondition);
});

test("an announced calendar deadline promotes a pending record to a normal event with the same identity", async () => {
  const { endCondition: _, ...details } = pending;
  const normal = { ...details, endAt: "2026-11-15T23:00:00+08:00" };
  const result = await collectAutomaticEvents(config, [candidate], document(), now, {}, {
    fetch: async () => Response.json({ Code: "0", Data: { Title: pending.title, Content: "2026年10月28日16:00～2026年11月15日22:59" } }),
    collect: async () => [normal],
  });
  assert.equal(result.events[0].id, pending.id); assert.deepEqual(result.pendingEvents, []);
  assert.deepEqual(result.reviewCandidates, []);
});

test("saved candidate text cannot refresh a pending activity when the current authoritative announcement fails", async () => {
  const result = await collectAutomaticEvents(config, [candidate], document(), new Date("2026-10-27T00:00:00+08:00"), { attempts: 1 }, {
    fetch: async () => new Response("unavailable", { status: 503 }),
    collect: async () => { throw new Error("stale saved text must not bypass current announcement verification"); },
  });
  assert.equal(result.pendingEvents[0].lastVerifiedAt, pending.lastVerifiedAt);
  assert.equal(result.failures.length, 1);
});

test("unknown-deadline verification refreshes publication freshness while scheduled timestamp-only updates stay quiet", () => {
  const before = document(); const after = structuredClone(before);
  after.pendingEvents![0].lastVerifiedAt = "2026-10-25T06:00:00Z";
  assert.equal(hasPublicationChanges(after, before), true);
});

test("legacy clients receive only complete scheduled activities even when pending activities exist", () => {
  const { endCondition: _, ...details } = pending;
  const complete = { ...details, id: "scheduled", endAt: "2026-11-15T23:00:00+08:00", questName: "任务", questNpc: "NPC",
    location: { territoryId: 1, mapId: 1, x: 0, y: 0, z: 0 }, rewards: [{ name: "奖励", category: "", description: "", flags: [] }] };
  assert.deepEqual(legacyEvents({ ...document(), events: [complete] }).map(item => item.id), ["scheduled"]);
});
