import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventLocation, EventReward, TeleportTarget } from "./models.js";

type CompletionOverride = {
  questId?: number | null;
  achievementId?: number | null;
  teleport?: TeleportTarget | null;
};

export interface CollectorOverrides {
  locations: Record<string, EventLocation>;
  rewards: Record<string, EventReward[]>;
  completion: Record<string, CompletionOverride>;
}

export interface CollectorConfiguration {
  configFile: string;
  approvedSourceUrls: string[];
  discoveryUrls: string[];
  pendingCandidateUrls: string[];
  ignoredCandidateUrls: string[];
  allowedCandidateHosts: string[];
  eventIds: Record<string, string>;
  overrides: CollectorOverrides;
}

interface ConfigurationFile {
  schemaVersion: 1;
  sources: {
    approved: string[];
    discovery: string[];
    pending: string[];
    ignored: string[];
    allowedCandidateHosts: string[];
  };
  eventIds: Record<string, string>;
  overrides: CollectorOverrides;
}

const defaultConfigurationFile = fileURLToPath(new URL("../config/collector.json", import.meta.url));

export function loadCollectorConfiguration(): CollectorConfiguration {
  const configuredPath = process.env.COLLECTOR_CONFIG_FILE?.trim();
  const configFile = configuredPath ? resolve(configuredPath) : defaultConfigurationFile;
  const document = parseConfigurationFile(readFileSync(configFile, "utf8"), configFile);
  const approvedSourceUrls = uniqueUrls([...document.sources.approved, ...readCsv("SOURCE_URLS")]);
  const eventIds = normalizeEventIdMap({
    ...document.eventIds,
    ...readEnvironmentMap("EVENT_ID_OVERRIDES") as Record<string, string>,
  });
  for (const sourceUrl of approvedSourceUrls) {
    if (!eventIds[sourceUrl]) throw new Error(`approved source has no stable event id mapping: ${sourceUrl}`);
  }

  return {
    configFile,
    approvedSourceUrls,
    discoveryUrls: uniqueUrls([...document.sources.discovery, ...readCsv("DISCOVERY_URLS")]),
    pendingCandidateUrls: uniqueUrls([...document.sources.pending, ...readCsv("CANDIDATE_URLS")]),
    ignoredCandidateUrls: uniqueUrls([...document.sources.ignored, ...readCsv("IGNORED_CANDIDATE_URLS")]),
    allowedCandidateHosts: uniqueStrings([
      ...document.sources.allowedCandidateHosts.map(value => value.toLowerCase()),
      ...readCsv("DISCOVERY_ALLOWED_HOSTS").map(value => value.toLowerCase()),
    ]),
    eventIds,
    overrides: {
      locations: { ...document.overrides.locations, ...readEnvironmentMap("LOCATION_OVERRIDES") } as Record<string, EventLocation>,
      rewards: { ...document.overrides.rewards, ...readEnvironmentMap("REWARD_OVERRIDES") } as Record<string, EventReward[]>,
      completion: { ...document.overrides.completion, ...readEnvironmentMap("COMPLETION_OVERRIDES") } as Record<string, CompletionOverride>,
    },
  };
}

function parseConfigurationFile(contents: string, path: string): ConfigurationFile {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`collector configuration is not valid JSON: ${path}`, { cause: error });
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`collector configuration has an unsupported schemaVersion: ${path}`);
  }
  if (!isRecord(value.sources) || !isRecord(value.eventIds) || !isRecord(value.overrides)) {
    throw new Error(`collector configuration is missing sources, eventIds, or overrides: ${path}`);
  }

  const sources = value.sources;
  const overrides = value.overrides;
  for (const name of ["approved", "discovery", "pending", "ignored", "allowedCandidateHosts"] as const) {
    if (!isStringArray(sources[name])) throw new Error(`collector configuration sources.${name} must be a string array`);
  }
  for (const name of ["locations", "rewards", "completion"] as const) {
    if (!isRecord(overrides[name])) throw new Error(`collector configuration overrides.${name} must be an object`);
  }
  for (const [url, id] of Object.entries(value.eventIds)) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
      throw new Error(`collector configuration eventIds has an invalid id for ${url}`);
    }
  }

  return value as unknown as ConfigurationFile;
}

function readEnvironmentMap(name: string): Record<string, unknown> {
  const source = process.env[name];
  if (source === undefined || source.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${name} must be valid JSON`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${name} must be a JSON object keyed by event id`);
  return value;
}

function readCsv(name: string): string[] {
  return (process.env[name] || "").split(",").map(value => value.trim()).filter(Boolean);
}

function uniqueUrls(values: string[]): string[] {
  const result = new Map<string, string>();
  for (const value of values) {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error(`collector URL must use HTTPS: ${value}`);
    result.set(url.href, url.href);
  }
  return [...result.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function normalizeEventIdMap(values: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [sourceUrl, id] of Object.entries(values)) {
    const url = new URL(sourceUrl);
    if (url.protocol !== "https:") throw new Error(`event id source URL must use HTTPS: ${sourceUrl}`);
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
      throw new Error(`invalid stable event id for ${sourceUrl}`);
    }
    result[url.href] = id;
  }
  return result;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
