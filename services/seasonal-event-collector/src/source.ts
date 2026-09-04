import { chromium, type Page } from "playwright";
import { createHash } from "node:crypto";
import type { EventReward, SeasonalEvent, TeleportTarget } from "./models.js";

export async function collectEvents(sourceUrls: string[]): Promise<SeasonalEvent[]> {
  if (sourceUrls.length === 0) {
    throw new Error("SOURCE_URLS must list the verified seasonal-event detail pages");
  }
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const page = await browser.newPage({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const events: SeasonalEvent[] = [];
    for (const url of sourceUrls) {
      events.push(await parseDetailPage(page, url));
    }
    return events;
  } finally {
    await browser.close();
  }
}

async function parseDetailPage(page: Page, url: string): Promise<SeasonalEvent> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);
  const body = await page.locator("body").innerText();

  const window = parseTimeWindow(body);
  const title = selectEventTitle(await page.locator("h1,h2,h3").allInnerTexts()) || extractLine(body, ["新生庆典", "庆典", "活动"]);
  const questName = extractQuestName(body, title ?? "");
  const questNpc = extractNpc(body);
  const coordinates = extractCoordinates(body);
  if (!window || !title || !questName || !questNpc) {
    throw new Error(`unable to parse required fields: ${url}`);
  }
  const id = slugify(`${title}-${window.startAt.slice(0, 4)}`);
  const location = resolveLocation(id, coordinates);
  const completion = resolveCompletion(id);
  const rewards = resolveRewards(id, await extractRewards(page));

  return {
    id,
    title,
    startAt: window.startAt,
    endAt: window.endAt,
    questName,
    questLevel: extractLevel(body),
    questNpc,
    questId: completion.questId ?? null,
    location,
    achievementId: completion.achievementId ?? null,
    ...(completion.teleport !== undefined ? { teleport: completion.teleport } : {}),
    rewards,
    sourceUrl: url,
    lastVerifiedAt: new Date().toISOString(),
  };
}

export function parseTimeWindow(text: string): { startAt: string; endAt: string } | null {
  const match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})\s*[～~至-]\s*(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, year, startMonth, startDay, startHour, startMinute, explicitEndYear, endMonth, endDay, endHour, endMinute] = match;
  const start = `${year}-${pad(startMonth)}-${pad(startDay)}T${pad(startHour)}:${startMinute}:00+08:00`;
  const endYear = explicitEndYear || (Number(endMonth) < Number(startMonth) ? String(Number(year) + 1) : year);
  const endMinuteDate = new Date(`${endYear}-${pad(endMonth)}-${pad(endDay)}T${pad(endHour)}:${endMinute}:00+08:00`);
  endMinuteDate.setMinutes(endMinuteDate.getMinutes() + 1);
  return { startAt: start, endAt: endMinuteDate.toISOString() };
}

export function extractCoordinates(text: string): { x: number; y: number } | null {
  const match = text.match(/X\s*[:：]\s*([\d.]+)\s*Y\s*[:：]\s*([\d.]+)/i);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

export function resolveLocation(id: string, coordinates: { x: number; y: number } | null) {
  const overrides = JSON.parse(process.env.LOCATION_OVERRIDES || "{}") as Record<string, { territoryId: number; mapId: number; x: number; y: number; z: number }>;
  const override = overrides[id];
  if (!override) throw new Error(`missing LOCATION_OVERRIDES entry for event: ${id}`);
  return coordinates
    ? { ...override, displayX: coordinates.x, displayY: coordinates.y }
    : override;
}

export function resolveRewards(id: string, extracted: EventReward[]): EventReward[] {
  const overrides = readOverrideMap("REWARD_OVERRIDES");
  const value = overrides[id];
  if (value === undefined) return extracted;
  if (!Array.isArray(value)) throw new Error(`invalid REWARD_OVERRIDES entry for event: ${id}`);
  return value as EventReward[];
}

export function resolveCompletion(id: string): {
  questId?: number | null;
  achievementId?: number | null;
  teleport?: TeleportTarget | null;
} {
  const overrides = readOverrideMap("COMPLETION_OVERRIDES");
  const value = overrides[id];
  if (value === undefined) return {};
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`invalid COMPLETION_OVERRIDES entry for event: ${id}`);
  return value as { questId?: number | null; achievementId?: number | null; teleport?: TeleportTarget | null };
}

function readOverrideMap(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(process.env[name] || "{}");
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
    throw new Error(`${name} must be a JSON object keyed by event id`);
  return parsed as Record<string, unknown>;
}

async function extractRewards(page: Page): Promise<EventReward[]> {
  const rewardCandidates = page.locator("[data-tooltip], [data-original-title], [class*='reward'] [title], [class*='reward'] [aria-label], [class*='reward'] img");
  const rewards = new Map<string, EventReward>();
  // A page may contain navigation icons with labels. Limiting probes bounds the work while
  // still covering the reward groups used by official seasonal-event pages.
  const count = Math.min(await rewardCandidates.count(), 120);
  for (let index = 0; index < count; index++) {
    const candidate = rewardCandidates.nth(index);
    const attributes = await candidate.evaluate(element => ({
      name: element.getAttribute("data-tooltip") || element.getAttribute("data-original-title") || element.getAttribute("title") || element.getAttribute("aria-label") || element.getAttribute("alt") || "",
      category: element.getAttribute("data-category") || "",
    }));
    const name = attributes.name.trim();
    if (!name) continue;

    try {
      await candidate.hover({ timeout: 500 });
      await page.waitForTimeout(80);
    } catch {
      // Attribute text remains usable when the element is not hoverable.
    }

    const tooltip = await visibleTooltipText(page);
    const description = tooltip && tooltip !== name ? tooltip : "";
    const flags = description.split(/\r?\n/)
      .map(value => value.trim())
      .filter(value => /(不可交易|可交易|唯一|不可出售|账号绑定|收藏品)/.test(value));
    rewards.set(name, { name, category: attributes.category, description, flags: [...new Set(flags)] });
  }

  return [...rewards.values()];
}

async function visibleTooltipText(page: Page): Promise<string> {
  const tooltips = page.locator('[role="tooltip"]:visible, .tooltip:visible, [class*="tooltip"]:visible');
  const count = await tooltips.count();
  for (let index = 0; index < count; index++) {
    const text = (await tooltips.nth(index).innerText()).trim();
    if (text) return text;
  }

  return "";
}

export function extractQuestName(text: string, title: string): string | null {
  const line = text.split(/\r?\n/)
    .map(value => value.trim())
    .find(value => /^任务(?:名称)?\s*[:：]\s*\S/.test(value));
  const explicitName = line?.replace(/^任务(?:名称)?\s*[:：]\s*/, "").trim();
  return explicitName || (title && text.includes(title) ? title : null);
}

export function extractNpc(text: string): string | null {
  for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const labeled = line.match(/NPC\s*[:：]?\s*["“]?([^"”\n]{2,40})["”]?/i);
    if (labeled?.[1]) return labeled[1].trim();
    const sentence = line.match(/^[^。\n]{1,50}?的(.{2,40}?)(?:有点|似乎|想要|正在|希望|需要)/);
    if (sentence?.[1]) return sentence[1].trim();
  }

  return null;
}

function extractLevel(text: string): number | null {
  const match = text.match(/等级\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

export function selectEventTitle(values: string[]): string | null {
  return values
    .map(value => value.trim())
    .find(value => value &&
      !/^(?:SEASONAL EVENT|季节活动|活動獎勵|活动奖励|接受任务条件|接取任务条件)$/i.test(value)) || null;
}

function extractLine(text: string, hints: string[]): string | null {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => hints.some(hint => line.includes(hint))) || null;
}

function slugify(value: string): string {
  return `seasonal-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function pad(value: string): string { return value.padStart(2, "0"); }
