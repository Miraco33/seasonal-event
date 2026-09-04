import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EventsDocument } from "./models.js";
import { assertEventCollectionIsPublishable, preparePublication, publish } from "./publisher.js";

const environmentKeys = [
  "PUBLISH_MODE",
  "OUTPUT_FILE",
  "ALLOW_EMPTY_EVENTS",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_BRANCH",
  "GITHUB_PATH",
] as const;

function documentWithVersion(dataVersion: number): EventsDocument {
  return {
    schemaVersion: 1,
    dataVersion,
    publishedAt: "2026-08-25T00:00:00.000Z",
    events: [{
      id: "the-rising-2026",
      title: "新生庆典与音乐的轨迹",
      startAt: "2026-08-27T07:00:00.000Z",
      endAt: "2026-09-10T15:00:00.000Z",
      questName: "新生庆典与音乐的轨迹",
      questLevel: 15,
      questNpc: "异国的诗人",
      location: { territoryId: 129, mapId: 23, x: 100, y: 200, z: 0 },
      achievementId: null,
      rewards: [{ name: "迷你乌克·拉玛特", category: "宠物", description: "", flags: [] }],
      sourceUrl: "https://actff1.web.sdo.com/project/example",
      lastVerifiedAt: "2026-08-25T00:00:00.000Z",
    }],
  };
}

async function withEnvironment(
  values: Partial<Record<(typeof environmentKeys)[number], string>>,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = new Map(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  try {
    await operation();
  } finally {
    for (const key of environmentKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function githubFileResponse(dataVersion: number, sha = "existing-sha"): Response {
  return Response.json({
    sha,
    encoding: "base64",
    content: Buffer.from(JSON.stringify({ dataVersion }), "utf8").toString("base64"),
  });
}

test("an empty collection requires the exact ALLOW_EMPTY_EVENTS=true opt-in", () => {
  for (const value of [undefined, "", "false", "TRUE", " true"] as const) {
    assert.throws(() => assertEventCollectionIsPublishable(0, value), /ALLOW_EMPTY_EVENTS=true/);
  }
  assert.doesNotThrow(() => assertEventCollectionIsPublishable(0, "true"));
  assert.doesNotThrow(() => assertEventCollectionIsPublishable(1, undefined));
});

test("filesystem publication increments the local version and starts at one when absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-event-"));
  const output = join(directory, "events.json");
  const unexpectedFetch: typeof fetch = async () => {
    throw new Error("filesystem mode must not call fetch");
  };

  try {
    await withEnvironment({ PUBLISH_MODE: "filesystem", OUTPUT_FILE: output }, async () => {
      assert.equal((await preparePublication(unexpectedFetch)).dataVersion, 1);
      await writeFile(output, JSON.stringify({ dataVersion: 8 }), "utf8");
      assert.equal((await preparePublication(unexpectedFetch)).dataVersion, 9);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem dry-run does not create an output or temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-event-"));
  const output = join(directory, "events.json");

  try {
    await withEnvironment({ PUBLISH_MODE: "filesystem", OUTPUT_FILE: output }, async () => {
      await publish(documentWithVersion(1), true);
      assert.equal(existsSync(output), false);
      assert.equal(existsSync(`${output}.tmp`), false);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitHub dry-run derives the version from remote content without sending a PUT", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return githubFileResponse(12);
  };

  await withEnvironment({
    PUBLISH_MODE: "github",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_BRANCH: "release/data",
    GITHUB_PATH: "feeds/events.json",
  }, async () => {
    const publication = await preparePublication(mockFetch);
    assert.equal(publication.dataVersion, 13);
    await publish(documentWithVersion(13), true, publication);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/owner/repository/contents/feeds/events.json?ref=release%2Fdata");
  assert.equal(calls[0].init?.method, undefined);
});

test("GitHub publication starts at one for a missing remote file", async () => {
  const mockFetch: typeof fetch = async () => new Response("not found", { status: 404 });

  await withEnvironment({
    PUBLISH_MODE: "github",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "owner/repository",
  }, async () => {
    assert.equal((await preparePublication(mockFetch)).dataVersion, 1);
  });
});

test("GitHub publication reuses the remote read sha when updating the file", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (init?.method === "PUT") return Response.json({}, { status: 200 });
    return githubFileResponse(20, "sha-from-read");
  };

  await withEnvironment({
    PUBLISH_MODE: "github",
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "owner/repository",
  }, async () => {
    const publication = await preparePublication(mockFetch);
    await publish(documentWithVersion(21), false, publication);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].init?.method, "PUT");
  const body = JSON.parse(String(calls[1].init?.body)) as { sha?: string; content: string };
  assert.equal(body.sha, "sha-from-read");
  const published = JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as EventsDocument;
  assert.equal(published.dataVersion, 21);
});

test("empty collection rejection happens before any filesystem write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-event-"));
  const output = join(directory, "events.json");

  try {
    await withEnvironment({ PUBLISH_MODE: "filesystem", OUTPUT_FILE: output }, async () => {
      const emptyDocument = { ...documentWithVersion(1), events: [] };
      await assert.rejects(publish(emptyDocument, false), /ALLOW_EMPTY_EVENTS=true/);
      assert.equal(existsSync(output), false);
      assert.equal(existsSync(`${output}.tmp`), false);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem publication writes the prepared next version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-event-"));
  const output = join(directory, "events.json");

  try {
    await writeFile(output, JSON.stringify({ dataVersion: 3 }), "utf8");
    await withEnvironment({ PUBLISH_MODE: "filesystem", OUTPUT_FILE: output }, async () => {
      const publication = await preparePublication();
      await publish(documentWithVersion(4), false, publication);
    });
    const written = JSON.parse(await readFile(output, "utf8")) as EventsDocument;
    assert.equal(written.dataVersion, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem publication refuses to run while another publisher holds the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-event-"));
  const output = join(directory, "events.json");

  try {
    await writeFile(output, JSON.stringify({ dataVersion: 3 }), "utf8");
    await writeFile(`${output}.lock`, "occupied", "utf8");
    await withEnvironment({ PUBLISH_MODE: "filesystem", OUTPUT_FILE: output }, async () => {
      const publication = await preparePublication();
      await assert.rejects(publish(documentWithVersion(4), false, publication), /already running/);
    });
    assert.equal((JSON.parse(await readFile(output, "utf8")) as { dataVersion: number }).dataVersion, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem publication rechecks the version after acquiring the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-event-"));
  const output = join(directory, "events.json");

  try {
    await writeFile(output, JSON.stringify({ dataVersion: 3 }), "utf8");
    await withEnvironment({ PUBLISH_MODE: "filesystem", OUTPUT_FILE: output }, async () => {
      const publication = await preparePublication();
      await writeFile(output, JSON.stringify({ dataVersion: 4 }), "utf8");
      await assert.rejects(publish(documentWithVersion(4), false, publication), /changed before write/);
    });
    assert.equal(existsSync(`${output}.lock`), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
