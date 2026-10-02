import assert from "node:assert/strict";
import test from "node:test";
import { collectAutomaticEvents, legacyEvents, stableEventId } from "./collection.js";
import type { CollectorConfiguration } from "./configuration.js";
import type { DiscoveryCandidate } from "./discovery.js";
import type { EventsDocument, SeasonalEvent } from "./models.js";
import { validateDocument } from "./validate.js";

const url = "https://actff1.web.sdo.com/project/20260915ffxv/index.html";
const announcementUrl = "https://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=393210";
const now = new Date("2026-10-02T12:00:00+08:00");
const configuration: CollectorConfiguration = {
  configFile: "unused", approvedSourceUrls: [], discoveryUrls: [], pendingCandidateUrls: [], ignoredCandidateUrls: [],
  allowedCandidateHosts: ["actff1.web.sdo.com"], eventIds: {}, overrides: { locations: {}, rewards: {}, completion: {} },
};
const candidate: DiscoveryCandidate = {
  url, title: "《最终幻想14》x 《最终幻想15》联动再启！", discoveredFrom: announcementUrl,
  sourceType: "discovered", matchedKeywords: ["ffxv"], reviewStatus: "pending", announcementUrl,
  announcementText: "活动时间：2026年9月24日16:00～2026年10月13日22:59",
};
function event(source = url): SeasonalEvent {
  return { id: stableEventId(source, {}), title: candidate.title,
    startAt: "2026-09-24T16:00:00+08:00", endAt: "2026-10-13T23:00:00+08:00",
    questName: null, questLevel: null, questNpc: null, location: null, questId: null, achievementId: null,
    rewards: [], sourceUrl: source, lastVerifiedAt: "2026-10-01T10:00:00+08:00" };
}
function document(events: SeasonalEvent[]): EventsDocument {
  return { schemaVersion: 2, dataVersion: 1, publishedAt: now.toISOString(), events };
}

test("automatic identities are stable across index/slash variants and preserve configured IDs", () => {
  assert.equal(stableEventId(url, {}), stableEventId(url.replace("index.html", ""), {}));
  assert.equal(stableEventId(url, {}), stableEventId(url.replace("/index.html", ""), {}));
  assert.equal(stableEventId(url, {}), stableEventId(url.replace("ffxv", "FFXV"), {}));
  assert.equal(stableEventId(url, { [url.replace("index.html", "")]: "legacy-permanent-id" }), "legacy-permanent-id");
  assert.notEqual(stableEventId(url, {}), stableEventId(url.replace("20260915", "20270915"), {}));
});
test("a discovered official activity publishes verified information without manual approval or invented coordinates", async () => {
  const result = await collectAutomaticEvents(configuration, [candidate], undefined, now, {}, {
    collect: async (urls, options) => {
      assert.deepEqual(urls, [url]);
      assert.equal(options.allowPartial, true);
      assert.equal(options.metadataFallbacks?.[stableEventId(url, {})].endAt, "2026-10-13T23:00:00+08:00");
      return [event()];
    },
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].location, null);
  assert.equal(result.events[0].announcementUrl, announcementUrl);
  assert.equal(result.reviewCandidates.length, 0);
  assert.equal(result.failures.length, 0);
  validateDocument(document(result.events));
});
test("published open activities remain monitored after the announcement leaves the discovery window", async () => {
  const previous = document([{ ...event(), announcementUrl }]);
  let requests = 0;
  const result = await collectAutomaticEvents(configuration, [], previous, now, {}, {
    fetch: async (request) => {
      assert.equal(request, announcementUrl); requests++;
      return Response.json({ Code: "0", Data: { Title: candidate.title, Content: candidate.announcementText } });
    },
    collect: async (urls, options) => {
      assert.deepEqual(urls, [url]);
      assert.equal(options.eventIds?.[url], previous.events[0].id);
      return [{ ...event(), endAt: options.metadataFallbacks![event().id].endAt! }];
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.events.length, 1);
});
test("failed activity parsing retains the exact previous verified event and exposes the failure", async () => {
  const old = event();
  const result = await collectAutomaticEvents(configuration, [candidate], document([old]), now, {}, {
    collect: async (_, options) => { options.onSourceError?.(url, new Error("required time missing")); return []; },
  });
  assert.deepEqual(result.events, [old]);
  assert.equal(result.failures[0].message, "required time missing");
  assert.equal(result.reviewCandidates.length, 1);
});
test("failed announcement refresh retains previous dates and does not relabel them freshly verified", async () => {
  const old = { ...event(), announcementUrl };
  const result = await collectAutomaticEvents(configuration, [], document([old]), now, { attempts: 1 }, {
    fetch: async () => new Response("unavailable", { status: 503 }),
    collect: async () => { throw new Error("must not collect from stale announcement metadata"); },
  });
  assert.deepEqual(result.events, [old]);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /503/);
});
test("missing core fields and invalid supplied coordinates are withheld, without suppressing independent valid activities", async () => {
  const badUrl = url.replace("ffxv", "bad-event");
  const badCandidate = { ...candidate, url: badUrl };
  const result = await collectAutomaticEvents(configuration, [candidate, badCandidate], undefined, now, {}, {
    collect: async () => [event(), { ...event(badUrl), location: { territoryId: 0, mapId: 1, x: 0, y: 0, z: 0 } }],
  });
  assert.equal(result.events.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.reviewCandidates[0].url, badUrl);
});
test("ignored, foreign-host and announced expired activities are not automatically fetched", async () => {
  const expired = { ...candidate, announcementText: "2026年8月27日15:00～9月10日22:59" };
  const foreign = { ...candidate, url: "https://example.com/project/ffxv/index.html" };
  const result = await collectAutomaticEvents({ ...configuration, ignoredCandidateUrls: [url] }, [candidate, expired, foreign], undefined, now, {}, {
    collect: async () => { throw new Error("no eligible source should be fetched"); },
  });
  assert.deepEqual(result.events, []);
});
test("legacy feed excludes partial events and removes new protocol fields from complete events", () => {
  const full = { ...event(), questName: "黑衣青年", questNpc: "琪琵·嘉奇亚",
    location: { territoryId: 130, mapId: 12, x: 1, y: 2, z: 3 },
    rewards: [{ name: "雷迦利亚G型", category: "坐骑", description: "", flags: [] }], announcementUrl };
  const legacy = legacyEvents(document([event(url.replace("ffxv", "partial")), full]));
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].announcementUrl, undefined);
  validateDocument({ ...document(legacy), schemaVersion: 1 });
});
test("partial v2 fields remain explicit unknowns while supplied invalid fields fail", () => {
  assert.doesNotThrow(() => validateDocument(document([event()])));
  assert.throws(() => validateDocument({ ...document([event()]), schemaVersion: 1 }));
  assert.throws(() => validateDocument(document([{ ...event(), questName: " " }])));
  assert.throws(() => validateDocument(document([{ ...event(), startAt: "invalid" }])));
  assert.throws(() => validateDocument(document([{ ...event(), startAt: "2026-02-30T00:00:00+08:00" }])));
  assert.throws(() => validateDocument(document([{ ...event(), rewards: [{ name: "", category: "", description: "", flags: [] }] }])));
});
test("server validation enforces the integer widths consumed by the C# client", () => {
  for (const field of ["questId", "achievementId"] as const) {
    assert.doesNotThrow(() => validateDocument(document([{ ...event(), [field]: 4294967295 }])));
    assert.throws(() => validateDocument(document([{ ...event(), [field]: 4294967296 }])));
  }
  assert.throws(() => validateDocument(document([{ ...event(), questLevel: 2147483648 }])));
  assert.throws(() => validateDocument({ ...document([event()]), dataVersion: 2147483648 }));
  assert.throws(() => validateDocument(document([{ ...event(), teleport: { aetheryteId: 4294967296, subIndex: 0 } }])));
});
