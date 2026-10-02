import { createHash } from "node:crypto";
import type { CollectorConfiguration, EventMetadataOverride } from "./configuration.js";
import type { DiscoveryCandidate } from "./discovery.js";
import { candidateUrlKey, extractAnnouncementText } from "./discovery.js";
import type { EventsDocument, SeasonalEvent } from "./models.js";
import { retryOperation, type NetworkOptions } from "./network.js";
import { collectEvents, parseTimeWindow, type SourceOptions } from "./source.js";
import { validateDocument } from "./validate.js";

export interface SourceFailure { url: string; message: string }
export interface ReviewCandidate extends DiscoveryCandidate {
  stableEventId: string;
  reviewGaps: string[];
}

export function stableEventId(url: string, configured: Record<string, string>): string {
  const key = sourceKey(url);
  const existing = Object.entries(configured).find(([source]) => sourceKey(source) === key);
  return existing?.[1] ?? `seasonal-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

export async function collectAutomaticEvents(
  configuration: CollectorConfiguration,
  candidates: DiscoveryCandidate[],
  previous: EventsDocument | undefined,
  now: Date,
  networkOptions: NetworkOptions = {},
  dependencies: {
    collect?: (urls: string[], options: SourceOptions) => Promise<SeasonalEvent[]>;
    fetch?: typeof globalThis.fetch;
  } = {},
): Promise<{ events: SeasonalEvent[]; failures: SourceFailure[]; reviewCandidates: ReviewCandidate[]; automaticSourceCount: number }> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const configuredIds = { ...configuration.eventIds };
  const sources = new Map<string, string>();
  const candidateByKey = new Map<string, DiscoveryCandidate>();
  const previousByKey = new Map<string, SeasonalEvent>();
  const ignored = new Set(configuration.ignoredCandidateUrls.map(sourceKey));
  const allowedHosts = new Set(configuration.allowedCandidateHosts);
  const failures: SourceFailure[] = [];
  const metadataFallbacks: Record<string, EventMetadataOverride> = {};
  const announcements = new Map<string, string>();

  for (const event of previous?.events ?? []) {
    previousByKey.set(sourceKey(event.sourceUrl), event);
    // Keep open/upcoming events under observation even when their announcement
    // leaves the news window. Expired automatic sources can leave the feed.
    if (Date.parse(event.endAt) > now.getTime() && !ignored.has(sourceKey(event.sourceUrl))) {
      sources.set(sourceKey(event.sourceUrl), event.sourceUrl);
      configuredIds[event.sourceUrl] = event.id;
      if (event.announcementUrl) announcements.set(sourceKey(event.sourceUrl), event.announcementUrl);
    }
  }
  for (const url of configuration.approvedSourceUrls) sources.set(sourceKey(url), url);
  for (const candidate of candidates) {
    const key = sourceKey(candidate.url);
    const url = new URL(candidate.url);
    if (ignored.has(key) || url.protocol !== "https:" || !allowedHosts.has(url.hostname)) continue;
    const announcedWindow = candidate.announcementText ? parseTimeWindow(candidate.announcementText) : null;
    if (announcedWindow && Date.parse(announcedWindow.endAt) <= now.getTime() && !sources.has(key)) continue;
    sources.set(key, candidate.url);
    candidateByKey.set(key, candidate);
    if (candidate.announcementUrl) announcements.set(key, candidate.announcementUrl);
  }

  for (const [key, url] of sources) {
    const id = stableEventId(url, configuredIds);
    configuredIds[url] = id;
    const candidate = candidateByKey.get(key);
    let text = candidate?.announcementText;
    let headline = candidate?.title;
    const announcementUrl = announcements.get(key);
    if (!text && announcementUrl) {
      try {
        const detail = await readAnnouncement(announcementUrl, fetchImpl, networkOptions);
        text = detail.text;
        headline = detail.title;
      } catch (error) {
        // A failed authoritative source is visible, and its last verified event
        // is retained below rather than replaced using a guessed time window.
        failures.push({ url: announcementUrl, message: message(error) });
        continue;
      }
    }
    const window = text ? parseTimeWindow(text) : null;
    metadataFallbacks[id] = {
      ...(headline?.trim() ? { title: headline.replace(/^【季节活动】\s*/, "").trim() } : {}),
      ...(window ?? {}),
    };
  }

  const announcementFailures = new Set(failures.map(failure => failure.url));
  const urls = [...sources].filter(([key]) => !announcementFailures.has(announcements.get(key) ?? "")).map(([, url]) => url);
  const collected = urls.length === 0 ? [] : await (dependencies.collect ?? collectEvents)(urls, {
    ...networkOptions,
    eventIds: configuredIds,
    overrides: configuration.overrides,
    metadataFallbacks,
    allowPartial: true,
    onSourceError: (url, error) => failures.push({ url, message: message(error) }),
  });
  const events = new Map<string, SeasonalEvent>();
  const approved = new Set(configuration.approvedSourceUrls.map(sourceKey));
  for (const event of collected) {
    const key = sourceKey(event.sourceUrl);
    const withAnnouncement = { ...event, ...(announcements.has(key) ? { announcementUrl: announcements.get(key) } : {}) };
    try {
      validateDocument({ schemaVersion: 2, dataVersion: 1, publishedAt: now.toISOString(), events: [withAnnouncement] });
      if (Date.parse(event.endAt) > now.getTime() || approved.has(key)) events.set(key, withAnnouncement);
    } catch (error) { failures.push({ url: event.sourceUrl, message: message(error) }); }
  }
  for (const [key, url] of sources) {
    if (events.has(key)) continue;
    const old = previousByKey.get(key);
    const sourceFailed = failures.some(failure => sourceKey(failure.url) === key || failure.url === announcements.get(key));
    if (old && sourceFailed) events.set(key, old);
  }
  const reviewCandidates: ReviewCandidate[] = [];
  for (const [key, candidate] of candidateByKey) {
    const failed = failures.find(failure => sourceKey(failure.url) === key || failure.url === announcements.get(key));
    if (failed) reviewCandidates.push({
      ...candidate,
      stableEventId: stableEventId(candidate.url, configuredIds),
      reviewGaps: ["required_title_or_time_not_verified"],
    });
  }
  return {
    events: [...events.values()].sort((a, b) => a.id.localeCompare(b.id)),
    failures,
    reviewCandidates,
    automaticSourceCount: [...sources.keys()].filter(key => !approved.has(key)).length,
  };
}

export function legacyEvents(document: EventsDocument): SeasonalEvent[] {
  return document.events.filter(event => {
    try { validateDocument({ ...document, schemaVersion: 1, events: [event], collectionStatus: undefined }); return true; }
    catch { return false; }
  }).map(({ announcementUrl: _announcementUrl, ...event }) => event);
}

function sourceKey(value: string): string {
  return candidateUrlKey(value);
}

async function readAnnouncement(url: string, fetchImpl: typeof globalThis.fetch, options: NetworkOptions): Promise<{ title: string; text: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "cqnews.web.sdo.com" ||
      parsed.pathname !== "/api/news/newsDetail" || parsed.searchParams.get("gameCode") !== "ff" ||
      !/^\d+$/.test(parsed.searchParams.get("id") ?? "")) throw new Error("untrusted announcement URL");
  return retryOperation(async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
    const value = await response.json() as { Code?: string; Data?: { Title?: string; Content?: string } };
    if (value.Code !== "0" || typeof value.Data?.Title !== "string" || typeof value.Data.Content !== "string") {
      throw new Error("official news detail returned an unsupported response");
    }
    return { title: value.Data.Title, text: extractAnnouncementText(value.Data) };
  }, { attempts: options.attempts ?? 3, baseDelayMs: options.baseDelayMs ?? 1000,
    onRetry: diagnostic => options.onRetry?.({ url, ...diagnostic }) });
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
