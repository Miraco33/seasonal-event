import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { loadCollectorConfiguration } from "../dist/configuration.js";
import { discoverCandidatePages } from "../dist/discovery.js";
import { collectAutomaticEvents, legacyEvents } from "../dist/collection.js";
import { preparePublication, publish } from "../dist/publisher.js";
import { validateDocument } from "../dist/validate.js";
import { resolveVerifiedQuest } from "../dist/verified-quests.js";

const roundsArgument = process.argv.find(value => value.startsWith("--rounds="));
const rounds = Number(roundsArgument?.split("=")[1] ?? "3");
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5, "--rounds must be 1 through 5");
const asOfArgument = process.argv.find(value => value.startsWith("--as-of="));
const asOf = new Date(asOfArgument?.slice("--as-of=".length) ?? Date.now());
assert.ok(Number.isFinite(asOf.getTime()), "--as-of must be a valid timestamp");
const timeLimit = setTimeout(() => { console.error("Live verification exceeded ten minutes"); process.exit(1); }, 600000);
await mkdir(resolve("output"), { recursive: true });
const directory = await mkdtemp(resolve("output/live-verification-"));
const output = join(directory, "events-v2.json");
if (!process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
  const chrome = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
  if (chrome) process.env.PLAYWRIGHT_EXECUTABLE_PATH = chrome;
}
const configuration = loadCollectorConfiguration();
const expected = new Map([
  ["https://actff1.web.sdo.com/project/20260915ffxv/index.html", ["2026-09-24T16:00:00+08:00", "2026-10-13T23:00:00+08:00"]],
  ["https://actff1.web.sdo.com/project/20260715youkai-watch/vaz1gqm16a3h/index.html", ["2026-08-04T16:00:00+08:00", "2026-10-05T23:00:00+08:00"]],
  ["https://actff1.web.sdo.com/project/20260928ff14fallguys/4kkmxknj3rno/index.html", ["2026-10-07T16:00:00+08:00", "2026-10-27T23:00:00+08:00"]],
]);
const summaries = [];
try {
  for (let round = 1; round <= rounds; round++) {
    const start = Date.now();
    const discovery = await discoverCandidatePages(configuration.discoveryUrls, configuration.approvedSourceUrls,
      configuration.pendingCandidateUrls, configuration.ignoredCandidateUrls, configuration.allowedCandidateHosts,
      { attempts: 2, baseDelayMs: 100 }, new Date(asOf.getTime() - 180 * 86400000));
    assert.deepEqual(discovery.errors, [], "official discovery must succeed completely");
    assert.ok(!discovery.candidates.some(candidate => /mogmog|莫古/.test(candidate.url + candidate.title)));
    for (const url of expected.keys()) assert.ok(discovery.candidates.some(candidate => candidate.url === url), `missing official candidate ${url}`);
    const publication = await preparePublication(globalThis.fetch, output);
    const previous = publication.existingDocument;
    const collection = await collectAutomaticEvents(configuration, discovery.candidates, previous, asOf, { attempts: 2, baseDelayMs: 100 });
    assert.deepEqual(collection.failures, [], "all eligible official event pages must parse");
    assert.equal(collection.reviewCandidates.length, new Set(collection.enrichmentIssues.map(issue => issue.url)).size,
      "only visible image-enrichment gaps may remain after core activity publication");
    for (const [url, dates] of expected) {
      const event = collection.events.find(event => event.sourceUrl === url);
      if (Date.parse(dates[1]) <= asOf.getTime()) {
        assert.equal(event, undefined, `expired automatic activity must leave the feed: ${url}`);
        continue;
      }
      assert.ok(event, `activity absent from automatically generated feed: ${url}`);
      assert.deepEqual([event.startAt, event.endAt], dates, `official dates changed for ${url}; recheck the announcement`);
      const targetName = url.includes("ffxv") ? "黑衣青年" : url.includes("fallguys") ? "抓紧胜利的王冠！" : null;
      const verified = resolveVerifiedQuest(targetName, url, configuration.overrides.verifiedQuests);
      if (verified) {
        assert.equal(event.questName, verified.questName);
        assert.equal(event.questNpc, verified.questNpc);
        assert.equal(event.questLevel, verified.questLevel);
        assert.deepEqual(event.location, verified.location);
        assert.equal(event.questId, verified.completion.questId);
        assert.equal(event.achievementId, verified.completion.achievementId ?? null);
        if (verified.rewards) assert.deepEqual(event.rewards, verified.rewards);
        if (url.includes("fallguys")) assert.equal(event.rewards.length, 23);
      } else {
        assert.equal(event.location, null, "unverified world coordinates must remain unknown");
      }
    }
    const document = { schemaVersion: 2, dataVersion: publication.dataVersion, publishedAt: new Date().toISOString(),
      events: collection.events, collectionStatus: collection.enrichmentIssues.length > 0
        ? { status: "alert", code: "image_enrichment_incomplete" } : { status: "ok", code: "healthy" } };
    validateDocument(document);
    const legacy = legacyEvents(document);
    assert.ok(legacy.length >= 1, "previously complete approved data must remain valid for legacy clients");
    validateDocument({ ...document, schemaVersion: 1, events: legacy, collectionStatus: undefined });
    const before = existsSync(output) ? await readFile(output, "utf8") : undefined;
    assert.equal(await publish(document, true, publication), round === 1, "dry-run must detect only semantic changes");
    assert.equal(existsSync(output) ? await readFile(output, "utf8") : undefined, before, "dry-run must never alter the published feed");
    const changed = await publish(document, false, publication);
    assert.equal(changed, round === 1, "repeated verified data must not create another version");
    const stored = JSON.parse(await readFile(output, "utf8"));
    assert.equal(stored.dataVersion, 1, "unchanged repeats must keep the first version");
    const summary = { round, eventCount: stored.events.length,
      activeCount: stored.events.filter(event => Date.parse(event.startAt) <= asOf.getTime() && asOf.getTime() < Date.parse(event.endAt)).length,
      upcomingCount: stored.events.filter(event => Date.parse(event.startAt) > asOf.getTime()).length,
      changed, elapsedMs: Date.now() - start, imageRecognitionIssues: collection.enrichmentIssues,
      fields: stored.events.map(event => ({ title: event.title, questName: event.questName, questNpc: event.questNpc,
        mapAvailable: event.location !== null, rewardCount: event.rewards.length })) };
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
  await writeFile(join(directory, "results.json"), JSON.stringify({ asOf: asOf.toISOString(), rounds: summaries }, null, 2) + "\n");
  console.log(`Live verification passed; inspect ${directory}`);
} finally { clearTimeout(timeLimit); }
