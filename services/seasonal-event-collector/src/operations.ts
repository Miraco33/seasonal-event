import type { DiscoveryCandidate } from "./discovery.js";
import type { SeasonalEvent } from "./models.js";

export interface NextEventAssessment {
  state: "ok" | "review_required" | "alert";
  code: "healthy" | "candidate_review_required" | "event_ending_without_candidate" | "no_active_event_without_candidate";
  warningHours: number;
  activeEventIds: string[];
  futureApprovedEventIds: string[];
  hoursUntilEarliestEnd: number | null;
}

export function assessNextEventReadiness(
  events: SeasonalEvent[],
  candidates: DiscoveryCandidate[],
  now: Date,
  warningHours: number,
): NextEventAssessment {
  if (!Number.isFinite(now.getTime())) throw new Error("next-event assessment requires a valid current time");
  if (!Number.isInteger(warningHours) || warningHours < 0) throw new Error("NEXT_EVENT_WARNING_HOURS must be a non-negative integer");

  const nowMs = now.getTime();
  const active = events.filter(event => Date.parse(event.startAt) <= nowMs && nowMs < Date.parse(event.endAt));
  const future = events.filter(event => Date.parse(event.startAt) > nowMs);
  const earliestEnd = active.length === 0 ? null : Math.min(...active.map(event => Date.parse(event.endAt)));
  const hoursUntilEarliestEnd = earliestEnd === null ? null : Math.max(0, (earliestEnd - nowMs) / 3_600_000);
  const base = {
    warningHours,
    activeEventIds: active.map(event => event.id),
    futureApprovedEventIds: future.map(event => event.id),
    hoursUntilEarliestEnd,
  };

  if (candidates.length > 0) {
    return { ...base, state: "review_required", code: "candidate_review_required" };
  }
  if (future.length > 0) {
    return { ...base, state: "ok", code: "healthy" };
  }
  if (active.length === 0) {
    return { ...base, state: "alert", code: "no_active_event_without_candidate" };
  }
  if (hoursUntilEarliestEnd !== null && hoursUntilEarliestEnd <= warningHours) {
    return { ...base, state: "alert", code: "event_ending_without_candidate" };
  }
  return { ...base, state: "ok", code: "healthy" };
}
