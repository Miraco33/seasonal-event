import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeCandidateReport, writeRunStatus } from "./run-status.js";

test("writes a semantic candidate report without run-specific metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-status-"));
  const output = join(directory, "candidates.json");
  const previous = process.env.CANDIDATE_OUTPUT_FILE;
  process.env.CANDIDATE_OUTPUT_FILE = output;
  try {
    await writeCandidateReport({
      status: "review_required",
      code: "candidate_review_required",
      candidates: [{ url: "https://example.com/next", reviewStatus: "pending" }],
    });
    const document = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.status, "review_required");
    assert.equal("runId" in document, false);
    assert.equal("publishedAt" in document, false);
  } finally {
    if (previous === undefined) delete process.env.CANDIDATE_OUTPUT_FILE;
    else process.env.CANDIDATE_OUTPUT_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomically replaces the latest run status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-status-"));
  const output = join(directory, "latest.json");
  const previous = process.env.STATUS_OUTPUT_FILE;
  process.env.STATUS_OUTPUT_FILE = output;
  try {
    await writeRunStatus({ runId: "first", status: "ok" });
    await writeRunStatus({ runId: "second", status: "alert" });
    const document = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    assert.equal(document.runId, "second");
    assert.equal(document.status, "alert");
    assert.deepEqual((await readdir(directory)).sort(), ["latest.json"]);
  } finally {
    if (previous === undefined) delete process.env.STATUS_OUTPUT_FILE;
    else process.env.STATUS_OUTPUT_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
