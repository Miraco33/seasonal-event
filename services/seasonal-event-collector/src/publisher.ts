import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventsDocument } from "./models.js";

type Fetch = typeof globalThis.fetch;

interface FilesystemPublishConfiguration {
  mode: "filesystem";
  output: string;
}

interface GitHubPublishConfiguration {
  mode: "github";
  endpoint: string;
  branch: string;
  headers: Record<string, string>;
}

type PublishConfiguration = FilesystemPublishConfiguration | GitHubPublishConfiguration;

interface ExistingPublication {
  document: unknown;
  sha?: string;
}

export interface PublicationPreparation {
  dataVersion: number;
  configuration: PublishConfiguration;
  existingDocument?: unknown;
  existingSha?: string;
  fetchImpl: Fetch;
}

export function assertEventCollectionIsPublishable(eventCount: number, allowEmptyEvents: string | undefined): void {
  if (!Number.isInteger(eventCount) || eventCount < 0) throw new Error("invalid event count");
  if (eventCount === 0 && allowEmptyEvents !== "true") {
    throw new Error("refusing to publish an empty event list; set ALLOW_EMPTY_EVENTS=true to allow it explicitly");
  }
}

export async function preparePublication(fetchImpl: Fetch = globalThis.fetch): Promise<PublicationPreparation> {
  const configuration = getPublishConfiguration();
  const existing = await readExistingPublication(configuration, fetchImpl);
  return {
    dataVersion: nextDataVersion(existing?.document),
    configuration,
    existingDocument: existing?.document,
    existingSha: existing?.sha,
    fetchImpl,
  };
}

export async function publish(
  document: EventsDocument,
  dryRun: boolean,
  prepared?: PublicationPreparation,
): Promise<boolean> {
  assertEventCollectionIsPublishable(document.events.length, process.env.ALLOW_EMPTY_EVENTS);
  const publication = prepared ?? await preparePublication();
  if (document.dataVersion !== publication.dataVersion) {
    throw new Error(`dataVersion ${document.dataVersion} does not match the next published version ${publication.dataVersion}`);
  }
  if (!hasPublicationChanges(document, publication.existingDocument)) return false;
  if (dryRun) return true;

  if (publication.configuration.mode === "filesystem") {
    return publishToFilesystem(document, publication);
  }

  await publishToGitHub(document, publication);
  return true;
}

export function hasPublicationChanges(document: EventsDocument, existingDocument: unknown): boolean {
  if (existingDocument === undefined) return true;
  return JSON.stringify(publicationSemantics(document)) !== JSON.stringify(publicationSemantics(existingDocument));
}

async function publishToFilesystem(
  document: EventsDocument,
  publication: PublicationPreparation,
): Promise<boolean> {
  const configuration = publication.configuration;
  if (configuration.mode !== "filesystem") throw new Error("filesystem publication requires filesystem configuration");

  const output = configuration.output;
  const lockPath = `${output}.lock`;
  const temporaryPath = `${output}.${randomUUID()}.tmp`;
  await mkdir(dirname(output), { recursive: true });

  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx");
  } catch (error) {
    if (isFileExists(error)) throw new Error(`another filesystem publication is already running: ${lockPath}`);
    throw error;
  }

  try {
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
    const existing = await readExistingPublication(configuration, publication.fetchImpl);
    if (!hasPublicationChanges(document, existing?.document)) return false;
    const lockedDataVersion = nextDataVersion(existing?.document);
    if (document.dataVersion !== lockedDataVersion) {
      throw new Error(`publication changed before write; expected dataVersion ${lockedDataVersion}`);
    }

    await writeFile(temporaryPath, serializeDocument(document), "utf8");
    await rename(temporaryPath, output);
    return true;
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } finally {
      try {
        await lockHandle.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }
}

function publicationSemantics(document: unknown): unknown {
  if (!isRecord(document)) return canonicalize(document);

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(document).sort()) {
    if (key === "dataVersion" || key === "publishedAt") continue;
    const value = document[key];
    if (key === "events" && Array.isArray(value)) {
      result[key] = value.map(event => canonicalizeEvent(event));
    } else if (value !== undefined) {
      result[key] = canonicalize(value);
    }
  }
  return result;
}

function canonicalizeEvent(event: unknown): unknown {
  if (!isRecord(event)) return canonicalize(event);

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(event).sort()) {
    if (key === "lastVerifiedAt") continue;
    const value = event[key];
    if (value !== undefined) result[key] = canonicalize(value);
  }
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalize(item));
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) result[key] = canonicalize(child);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPublishConfiguration(): PublishConfiguration {
  const mode = process.env.PUBLISH_MODE || "filesystem";
  if (mode === "filesystem") {
    return {
      mode,
      output: process.env.OUTPUT_FILE || "../../data/seasonal-event/events.json",
    };
  }

  if (mode === "github") {
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const path = process.env.GITHUB_PATH || "data/seasonal-event/events.json";
    const branch = process.env.GITHUB_BRANCH || "main";
    if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");

    return {
      mode,
      endpoint: `https://api.github.com/repos/${repository}/contents/${path}`,
      branch,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "seasonal-event-collector",
      },
    };
  }

  throw new Error(`unsupported PUBLISH_MODE: ${mode}`);
}

async function readExistingPublication(
  configuration: PublishConfiguration,
  fetchImpl: Fetch,
): Promise<ExistingPublication | undefined> {
  if (configuration.mode === "filesystem") {
    try {
      return { document: JSON.parse(await readFile(configuration.output, "utf8")) as unknown };
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
  }

  const response = await fetchImpl(
    `${configuration.endpoint}?ref=${encodeURIComponent(configuration.branch)}`,
    { headers: configuration.headers },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub read failed: ${response.status}`);

  const payload = await response.json() as { sha?: unknown; encoding?: unknown; content?: unknown };
  if (typeof payload.sha !== "string" || payload.sha.length === 0) {
    throw new Error("GitHub read returned no file sha");
  }
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error("GitHub read returned no base64 file content");
  }

  return {
    document: JSON.parse(Buffer.from(payload.content, "base64").toString("utf8")) as unknown,
    sha: payload.sha,
  };
}

function nextDataVersion(document: unknown): number {
  if (document === undefined) return 1;
  if (typeof document !== "object" || document === null || !("dataVersion" in document)) {
    throw new Error("existing publication has no dataVersion");
  }

  const current = (document as { dataVersion?: unknown }).dataVersion;
  if (!Number.isSafeInteger(current) || (current as number) < 1) {
    throw new Error("existing publication has an invalid dataVersion");
  }
  if (current === Number.MAX_SAFE_INTEGER) throw new Error("existing publication dataVersion cannot be incremented safely");
  return (current as number) + 1;
}

async function publishToGitHub(document: EventsDocument, publication: PublicationPreparation): Promise<void> {
  const configuration = publication.configuration;
  if (configuration.mode !== "github") throw new Error("GitHub publication requires GitHub configuration");

  const response = await publication.fetchImpl(configuration.endpoint, {
    method: "PUT",
    headers: { ...configuration.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "chore(data): update seasonal events",
      content: Buffer.from(serializeDocument(document), "utf8").toString("base64"),
      branch: configuration.branch,
      ...(publication.existingSha ? { sha: publication.existingSha } : {}),
    }),
  });
  if (!response.ok) throw new Error(`GitHub publish failed: ${response.status} ${await response.text()}`);
}

function serializeDocument(document: EventsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
