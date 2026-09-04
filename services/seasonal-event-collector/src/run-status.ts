import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function writeDiagnostic(value: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    type: "seasonal-event-collector-diagnostic",
    schemaVersion: 1,
    at: new Date().toISOString(),
    ...value,
  }));
}

export async function writeRunStatus(value: Record<string, unknown>): Promise<void> {
  const document = {
    type: "seasonal-event-collector-status",
    schemaVersion: 1,
    ...value,
  };
  const serialized = `${JSON.stringify(document)}\n`;
  console.log(serialized.trimEnd());

  const output = process.env.STATUS_OUTPUT_FILE?.trim();
  if (!output) return;
  await writeAtomic(output, serialized);
}

export async function writeCandidateReport(value: {
  status: string;
  code: string;
  candidates: unknown[];
  failedDiscoverySources?: string[];
}): Promise<void> {
  const output = process.env.CANDIDATE_OUTPUT_FILE?.trim();
  if (!output) return;
  const serialized = `${JSON.stringify({ schemaVersion: 1, ...value }, null, 2)}\n`;
  await writeAtomic(output, serialized);
}

async function writeAtomic(output: string, serialized: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, "utf8");
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}
