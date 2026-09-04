import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCollectorConfiguration } from "./configuration.js";

const environmentNames = [
  "COLLECTOR_CONFIG_FILE", "SOURCE_URLS", "DISCOVERY_URLS", "CANDIDATE_URLS", "IGNORED_CANDIDATE_URLS",
  "DISCOVERY_ALLOWED_HOSTS", "EVENT_ID_OVERRIDES", "LOCATION_OVERRIDES", "REWARD_OVERRIDES", "COMPLETION_OVERRIDES",
] as const;

test("loads the current public source, stable id, and overrides from versioned configuration", () => {
  const configuration = loadCollectorConfiguration();
  const source = "https://actff1.web.sdo.com/project/20260817The_Rising/7rzrnb48uiw9/index.html";
  assert.ok(configuration.approvedSourceUrls.includes(source));
  assert.equal(configuration.eventIds[source], "seasonal-aae61e8dfaea");
  assert.equal(configuration.overrides.locations["seasonal-aae61e8dfaea"].territoryId, 128);
  assert.ok(configuration.overrides.rewards["seasonal-aae61e8dfaea"].length > 0);
});

test("keeps legacy environment sources and overrides compatible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-config-"));
  const path = join(directory, "collector.json");
  await writeFile(path, JSON.stringify(configurationDocument({
    "https://example.com/approved": "event-approved",
  })), "utf8");

  await withEnvironment({
    COLLECTOR_CONFIG_FILE: path,
    SOURCE_URLS: "https://example.com/environment",
    EVENT_ID_OVERRIDES: JSON.stringify({ "https://example.com/environment": "event-environment" }),
    LOCATION_OVERRIDES: JSON.stringify({ "event-environment": { territoryId: 2, mapId: 3, x: 4, y: 5, z: 6 } }),
  }, async () => {
    const configuration = loadCollectorConfiguration();
    assert.deepEqual(configuration.approvedSourceUrls, [
      "https://example.com/approved", "https://example.com/environment",
    ]);
    assert.equal(configuration.eventIds["https://example.com/environment"], "event-environment");
    assert.equal(configuration.overrides.locations["event-environment"].mapId, 3);
  });
  await rm(directory, { recursive: true, force: true });
});

test("requires every approved source to have an explicit stable id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-config-"));
  const path = join(directory, "collector.json");
  const document = configurationDocument({});
  document.sources.approved = ["https://example.com/unmapped"];
  await writeFile(path, JSON.stringify(document), "utf8");

  await withEnvironment({ COLLECTOR_CONFIG_FILE: path }, async () => {
    assert.throws(() => loadCollectorConfiguration(), /no stable event id mapping/);
  });
  await rm(directory, { recursive: true, force: true });
});

function configurationDocument(eventIds: Record<string, string>) {
  return {
    schemaVersion: 1 as const,
    sources: {
      approved: Object.keys(eventIds), discovery: [], pending: [], ignored: [], allowedCandidateHosts: ["example.com"],
    },
    eventIds,
    overrides: { locations: {}, rewards: {}, completion: {} },
  };
}

async function withEnvironment(values: Partial<Record<(typeof environmentNames)[number], string>>, operation: () => Promise<void>) {
  const previous = new Map(environmentNames.map(name => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  try {
    await operation();
  } finally {
    for (const name of environmentNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
