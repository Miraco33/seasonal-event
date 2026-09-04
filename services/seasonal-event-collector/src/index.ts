import type { EventsDocument } from "./models.js";
import { assertEventCollectionIsPublishable, preparePublication, publish } from "./publisher.js";
import { collectEvents } from "./source.js";
import { validateDocument } from "./validate.js";

const sourceUrls = (process.env.SOURCE_URLS || "").split(",").map(value => value.trim()).filter(Boolean);
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const events = await collectEvents(sourceUrls);
  assertEventCollectionIsPublishable(events.length, process.env.ALLOW_EMPTY_EVENTS);
  const publication = await preparePublication();
  const document: EventsDocument = {
    schemaVersion: 1,
    dataVersion: publication.dataVersion,
    publishedAt: new Date().toISOString(),
    events,
  };
  validateDocument(document);
  await publish(document, dryRun, publication);
  console.log(JSON.stringify({ eventCount: events.length, dryRun, publishMode: process.env.PUBLISH_MODE || "filesystem" }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
