import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveryCandidate } from "./discovery.js";
import type { SeasonalEvent } from "./models.js";
import { assessNextEventReadiness } from "./operations.js";

test("alerts when an active event is ending and there is no next candidate", () => {
  const result = assessNextEventReadiness([
    event("current", "2026-09-10T23:00:00+08:00"),
  ], [], new Date("2026-09-04T12:00:00+08:00"), 168);
  assert.equal(result.state, "alert");
  assert.equal(result.code, "event_ending_without_candidate");
});

test("marks a discovered candidate for review without treating it as approved", () => {
  const candidate: DiscoveryCandidate = {
    url: "https://actff1.web.sdo.com/project/next/",
    title: "【季节活动】下一活动",
    discoveredFrom: "https://example.com/news",
    sourceType: "discovered",
    matchedKeywords: ["季节活动"],
    reviewStatus: "pending",
  };
  const result = assessNextEventReadiness([
    event("current", "2026-09-10T23:00:00+08:00"),
  ], [candidate], new Date("2026-09-04T12:00:00+08:00"), 168);
  assert.equal(result.state, "review_required");
  assert.equal(result.code, "candidate_review_required");
});

test("accepts a future event that has already passed review", () => {
  const future = event("future", "2026-10-10T23:00:00+08:00");
  future.startAt = "2026-10-01T15:00:00+08:00";
  const result = assessNextEventReadiness([future], [], new Date("2026-09-04T12:00:00+08:00"), 168);
  assert.equal(result.state, "ok");
});

function event(id: string, endAt: string): SeasonalEvent {
  return {
    id,
    title: id,
    startAt: "2026-08-27T15:00:00+08:00",
    endAt,
    questName: id,
    questLevel: 15,
    questNpc: "NPC",
    location: { territoryId: 1, mapId: 1, x: 0, y: 0, z: 0 },
    achievementId: null,
    rewards: [{ name: "奖励", category: "", description: "", flags: [] }],
    sourceUrl: "https://example.com/event",
    lastVerifiedAt: "2026-09-04T00:00:00Z",
  };
}
