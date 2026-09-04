import { randomUUID } from "node:crypto";
import { loadCollectorConfiguration } from "./configuration.js";
import { discoverCandidatePages } from "./discovery.js";
import type { DiscoveryCandidate } from "./discovery.js";
import type { EventsDocument } from "./models.js";
import { assessNextEventReadiness } from "./operations.js";
import { assertEventCollectionIsPublishable, preparePublication, publish } from "./publisher.js";
import { writeCandidateReport, writeDiagnostic, writePreviewDocument, writeRunStatus } from "./run-status.js";
import { collectEvents } from "./source.js";
import { validateDocument } from "./validate.js";

const runId = randomUUID();
const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();
const dryRun = process.argv.includes("--dry-run");
const discoverOnly = process.argv.includes("--discover-only");
let phase = "configuration";
let networkRetries = 0;
let latestReviewCandidates: unknown[] = [];

async function main(): Promise<void> {
  const configuration = loadCollectorConfiguration();
  const retryAttempts = readInteger("NETWORK_RETRY_ATTEMPTS", 3, 1, 10);
  const retryDelayMs = readInteger("NETWORK_RETRY_DELAY_MS", 1000, 0, 10000);
  const warningHours = readInteger("NEXT_EVENT_WARNING_HOURS", 168, 0, 8760);
  const discoveryLookbackDays = readInteger("DISCOVERY_LOOKBACK_DAYS", 30, 1, 365);
  const networkOptions = {
    attempts: retryAttempts,
    baseDelayMs: retryDelayMs,
    onRetry: (diagnostic: { url: string; attempt: number; maxAttempts: number; delayMs: number; reason: string }) => {
      networkRetries++;
      writeDiagnostic({ level: "warning", code: "network_retry", ...diagnostic });
    },
  };

  phase = "candidate_discovery";
  const discovery = await discoverCandidatePages(
    configuration.discoveryUrls,
    configuration.approvedSourceUrls,
    configuration.pendingCandidateUrls,
    configuration.ignoredCandidateUrls,
    configuration.allowedCandidateHosts,
    networkOptions,
    new Date(Date.now() - discoveryLookbackDays * 86_400_000),
  );
  const reviewCandidates = addCandidateReviewGaps(discovery.candidates, configuration);
  latestReviewCandidates = reviewCandidates;

  if (discoverOnly) {
    const status = discovery.errors.length > 0 ? "alert" : discovery.candidates.length > 0 ? "review_required" : "ok";
    const code = discovery.errors.length > 0 ? "candidate_discovery_failed" :
      discovery.candidates.length > 0 ? "candidate_review_required" : "no_candidate_found";
    await writeCandidateReport({
      status,
      code,
      candidates: reviewCandidates,
      ...(discovery.errors.length > 0 ? { failedDiscoverySources: discovery.errors.map(error => error.url).sort() } : {}),
    });
    const finishedAtMs = Date.now();
    await writeRunStatus({
      runId,
      status,
      code,
      phase: "complete",
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      discoverOnly: true,
      discoveryLookbackDays,
      discoverySourceCount: configuration.discoveryUrls.length,
      networkRetries,
      candidateCount: reviewCandidates.length,
      candidates: reviewCandidates,
      discoveryErrors: discovery.errors,
    });
    if (status !== "ok") process.exitCode = 2;
    return;
  }

  phase = "collection";
  const events = await collectEvents(configuration.approvedSourceUrls, {
    ...networkOptions,
    eventIds: configuration.eventIds,
    overrides: configuration.overrides,
  });
  assertEventCollectionIsPublishable(events.length, process.env.ALLOW_EMPTY_EVENTS);

  phase = "publication";
  const publication = await preparePublication();
  const document: EventsDocument = {
    schemaVersion: 1,
    dataVersion: publication.dataVersion,
    publishedAt: new Date().toISOString(),
    events,
  };
  validateDocument(document);
  if (dryRun) await writePreviewDocument(document);
  const changed = await publish(document, dryRun, publication);

  phase = "readiness_assessment";
  const readiness = assessNextEventReadiness(events, discovery.candidates, new Date(), warningHours);
  const hasDiscoveryFailure = discovery.errors.length > 0;
  const status = hasDiscoveryFailure ? "alert" : readiness.state;
  const code = hasDiscoveryFailure ? "candidate_discovery_failed" : readiness.code;
  await writeCandidateReport({
    status,
    code,
    candidates: reviewCandidates,
    ...(hasDiscoveryFailure ? { failedDiscoverySources: discovery.errors.map(error => error.url).sort() } : {}),
  });
  const finishedAtMs = Date.now();
  await writeRunStatus({
    runId,
    status,
    code,
    phase: "complete",
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    dryRun,
    discoverOnly: false,
    publishMode: process.env.PUBLISH_MODE || "filesystem",
    eventCount: events.length,
    changed,
    approvedSourceCount: configuration.approvedSourceUrls.length,
    discoverySourceCount: configuration.discoveryUrls.length,
    discoveryLookbackDays,
    networkRetries,
    candidateCount: reviewCandidates.length,
    candidates: reviewCandidates,
    discoveryErrors: discovery.errors,
    nextEvent: readiness,
  });

  // Exit 2 is an operational alert. The Oracle wrapper still publishes validated
  // approved data, then preserves this status so systemd reports attention needed.
  if (status !== "ok") process.exitCode = 2;
}

main().catch(async error => {
  const finishedAtMs = Date.now();
  const failure = {
    runId,
    status: "error",
    code: "run_failed",
    phase,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    dryRun,
    discoverOnly,
    publishMode: process.env.PUBLISH_MODE || "filesystem",
    networkRetries,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error && error.stack ? error.stack.slice(0, 8000) : null,
    },
  };
  try {
    await writeCandidateReport({
      status: "error",
      code: "run_failed",
      candidates: latestReviewCandidates,
      failedPhase: phase,
    });
  } catch (candidateStatusError) {
    console.error(JSON.stringify({
      type: "seasonal-event-collector-diagnostic",
      schemaVersion: 1,
      at: new Date().toISOString(),
      level: "error",
      code: "candidate_status_write_failed",
      message: candidateStatusError instanceof Error ? candidateStatusError.message : String(candidateStatusError),
    }));
  }
  try {
    await writeRunStatus(failure);
  } catch (statusError) {
    console.error(JSON.stringify({
      type: "seasonal-event-collector-diagnostic",
      schemaVersion: 1,
      at: new Date().toISOString(),
      level: "error",
      code: "status_write_failed",
      message: statusError instanceof Error ? statusError.message : String(statusError),
      failure,
    }));
  }
  process.exitCode = 1;
});

function readInteger(name: string, defaultValue: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function addCandidateReviewGaps(
  candidates: DiscoveryCandidate[],
  configuration: ReturnType<typeof loadCollectorConfiguration>,
): Array<DiscoveryCandidate & { stableEventId: string | null; reviewGaps: string[] }> {
  return candidates.map(candidate => {
    const stableEventId = configuration.eventIds[new URL(candidate.url).href] ?? null;
    const reviewGaps = ["detail_fields_not_inspected"];
    if (!stableEventId) reviewGaps.push("stable_event_id");
    if (!stableEventId || !configuration.overrides.locations[stableEventId]) reviewGaps.push("location_override");
    if (!stableEventId || !configuration.overrides.rewards[stableEventId]) reviewGaps.push("reward_override");
    if (!stableEventId || !configuration.overrides.completion[stableEventId]) reviewGaps.push("completion_override");
    return { ...candidate, stableEventId, reviewGaps };
  });
}
