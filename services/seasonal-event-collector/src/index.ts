import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { collectAutomaticEvents, legacyEvents } from "./collection.js";
import { loadCollectorConfiguration } from "./configuration.js";
import { discoverCandidatePages } from "./discovery.js";
import type { DiscoveryCandidate } from "./discovery.js";
import type { EventsDocument } from "./models.js";
import { assessNextEventReadiness } from "./operations.js";
import { assertEventCollectionIsPublishable, preparePublication, publish } from "./publisher.js";
import { writeCandidateReport, writeDiagnostic, writePreviewDocument, writeRunStatus } from "./run-status.js";
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
  const discoveryLookbackDays = readInteger("DISCOVERY_LOOKBACK_DAYS", 180, 1, 365);
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
  const savedCandidates = await readSavedCandidates(configuration);
  const discoveredCandidates = [...new Map([...savedCandidates, ...discovery.candidates].map(candidate => [candidate.url, candidate])).values()];
  let reviewCandidates = discoveredCandidates.map(candidate => ({ ...candidate, reviewGaps: ["required_title_or_time_not_verified"] }));
  latestReviewCandidates = reviewCandidates;

  if (discoverOnly) {
    const status = discovery.errors.length > 0 ? "alert" : discoveredCandidates.length > 0 ? "review_required" : "ok";
    const code = discovery.errors.length > 0 ? "candidate_discovery_failed" :
      discoveredCandidates.length > 0 ? "candidate_review_required" : "no_candidate_found";
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
  const publication = await preparePublication();
  const previous = publication.existingDocument as EventsDocument | undefined;
  if (previous !== undefined) validateDocument(previous);
  const collection = await collectAutomaticEvents(configuration, discoveredCandidates, previous, new Date(), networkOptions);
  const events = collection.events;
  reviewCandidates = collection.reviewCandidates;
  latestReviewCandidates = reviewCandidates;
  assertEventCollectionIsPublishable(events.length, process.env.ALLOW_EMPTY_EVENTS);

  const readiness = assessNextEventReadiness(events, collection.reviewCandidates, new Date(), warningHours);
  const hasDiscoveryFailure = discovery.errors.length > 0;
  const hasCollectionFailure = collection.failures.length > 0;
  const status = hasDiscoveryFailure || hasCollectionFailure ? "alert" : readiness.state;
  const code = hasDiscoveryFailure ? "candidate_discovery_failed" :
    hasCollectionFailure ? "candidate_collection_failed" : readiness.code;

  phase = "publication";
  const document: EventsDocument = {
    schemaVersion: 2,
    dataVersion: publication.dataVersion,
    publishedAt: new Date().toISOString(),
    events,
    collectionStatus: {
      status: status === "ok" ? "ok" : "alert",
      code,
      ...((hasDiscoveryFailure || hasCollectionFailure) ? {
        unavailableSources: [...new Set([...discovery.errors, ...collection.failures].map(error => error.url))].sort(),
      } : {}),
    },
  };
  validateDocument(document);
  if (dryRun) await writePreviewDocument(document);
  const changed = await publish(document, dryRun, publication);
  const legacyOutput = process.env.LEGACY_OUTPUT_FILE?.trim();
  if (legacyOutput) {
    const legacyPublication = await preparePublication(globalThis.fetch, legacyOutput);
    const legacyDocument: EventsDocument = {
      schemaVersion: 1, dataVersion: legacyPublication.dataVersion,
      publishedAt: document.publishedAt, events: legacyEvents(document),
    };
    validateDocument(legacyDocument);
    await publish(legacyDocument, dryRun, legacyPublication, true);
  }

  phase = "readiness_assessment";
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
    collectionErrors: collection.failures,
    automaticSourceCount: collection.automaticSourceCount,
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

async function readSavedCandidates(configuration: ReturnType<typeof loadCollectorConfiguration>): Promise<DiscoveryCandidate[]> {
  const path = process.env.CANDIDATE_OUTPUT_FILE?.trim();
  if (!path) return [];
  let content: string;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const report = JSON.parse(content) as { schemaVersion?: unknown; candidates?: unknown };
  if (report.schemaVersion !== 1 || !Array.isArray(report.candidates)) throw new Error("invalid saved candidate report");
  return report.candidates.filter((candidate: DiscoveryCandidate) => {
    const url = new URL(candidate.url);
    return url.protocol === "https:" && configuration.allowedCandidateHosts.includes(url.hostname) &&
      !configuration.ignoredCandidateUrls.includes(url.href) && !configuration.approvedSourceUrls.includes(url.href);
  });
}
