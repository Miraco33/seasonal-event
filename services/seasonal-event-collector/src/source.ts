import { chromium, type Page } from "playwright";
import { loadCollectorConfiguration, type CollectorOverrides, type EventMetadataOverride } from "./configuration.js";
import type { EventReward, SeasonalEvent, TeleportTarget } from "./models.js";
import { navigateWithRetry, type NetworkOptions } from "./network.js";

export type SourceOptions = NetworkOptions & {
  overrides?: CollectorOverrides;
  eventIds?: Record<string, string>;
  metadataFallbacks?: Record<string, EventMetadataOverride>;
  allowPartial?: boolean;
  onSourceError?: (url: string, error: unknown) => void;
};

export async function collectEvents(
  sourceUrls: string[],
  options: SourceOptions = {},
): Promise<SeasonalEvent[]> {
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
      try {
        events.push(await parseDetailPage(page, url, options));
      } catch (error) {
        if (!options.onSourceError) throw error;
        options.onSourceError(url, error);
      }
    }
    return events;
  } finally {
    await browser.close();
  }
}

export async function parseDetailPage(
  page: Page,
  url: string,
  options: SourceOptions = {},
): Promise<SeasonalEvent> {
  await navigateWithRetry(page, url, options);
  await page.waitForTimeout(1000);
  const body = await page.locator("body").innerText();

  const configuration = options.overrides && options.eventIds ? undefined : loadCollectorConfiguration();
  const eventIds = options.eventIds ?? configuration?.eventIds ?? {};
  const id = eventIds[new URL(url).href];
  if (!id) throw new Error(`missing stable event id mapping for source: ${url}`);
  const overrides = options.overrides ?? configuration?.overrides ?? loadCollectorConfiguration().overrides;
  const metadata = overrides.metadata?.[id];
  const fallback = options.metadataFallbacks?.[id];
  const parsedWindow = parseTimeWindow(body);
  const startAt = metadata?.startAt ?? parsedWindow?.startAt ?? fallback?.startAt;
  const endAt = metadata?.endAt ?? parsedWindow?.endAt ?? fallback?.endAt;
  const title = metadata?.title ?? selectEventTitle(await page.locator("h1,h2,h3").allInnerTexts(), await page.title()) ?? fallback?.title;
  const questHeadings = await page.locator(".quest h2, .quest h3, .quest h4, [class*='quest__title'], [class*='quest_title']")
    .evaluateAll(elements => elements.map(element =>
      element.textContent?.trim() || element.querySelector("img")?.getAttribute("alt")?.trim() || ""));
  const parsedQuestName = selectEventTitle(questHeadings) ?? extractQuestName(body, title ?? "");
  const questName = metadata?.questName !== undefined ? metadata.questName : parsedQuestName ?? fallback?.questName ?? null;
  const questNpc = metadata?.questNpc !== undefined ? metadata.questNpc : extractNpc(body) ?? fallback?.questNpc ?? null;
  const missing = [
    !title && "title", !startAt && "startAt", !endAt && "endAt",
    !options.allowPartial && !questName && "questName", !options.allowPartial && !questNpc && "questNpc",
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`unable to parse required fields (${missing.join(", ")}): ${url}`);
  const coordinates = extractCoordinates(body);
  const location = options.allowPartial && overrides.locations[id] === undefined ? null : resolveLocation(id, coordinates, overrides);
  const completion = resolveCompletion(id, overrides);
  const rewards = resolveRewards(id, await extractRewards(page), overrides);

  return {
    id,
    title: title!,
    startAt: startAt!,
    endAt: endAt!,
    questName,
    questLevel: metadata?.questLevel !== undefined ? metadata.questLevel : extractLevel(body) ?? fallback?.questLevel ?? null,
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
  const dateSeparator = "\\s*(?:年|[./-])\\s*";
  const monthSeparator = "\\s*(?:月|[./-])\\s*";
  const clock = "(?:日)?\\s*(?:[（(][^()（）\\n]{1,12}[）)]\\s*)?(\\d{1,2})\\s*[:：]\\s*(\\d{2})(?!\\d)";
  const startDate = `(\\d{4})${dateSeparator}(\\d{1,2})${monthSeparator}(\\d{1,2})${clock}`;
  const endDate = `(?:(\\d{4})${dateSeparator})?(\\d{1,2})${monthSeparator}(\\d{1,2})${clock}`;
  const match = text.match(new RegExp(`${startDate}\\s*(?:开始\\s+|(?:开始\\s*)?(?:[～~至—–-]+|到)\\s*)${endDate}`));
  if (!match) return null;
  const [, year, startMonth, startDay, startHour, startMinute, explicitEndYear, endMonth, endDay, endHour, endMinute] = match;
  const endYear = explicitEndYear || (Number(endMonth) < Number(startMonth) ? String(Number(year) + 1) : year);
  const start = dateBoundary(year, startMonth, startDay, startHour, startMinute);
  const end = dateBoundary(endYear, endMonth, endDay, endHour, endMinute);
  if (!start || !end || Date.parse(end) <= Date.parse(start)) return null;
  const endMinuteDate = new Date(end);
  // Official pages use xx:59 to mean the whole final minute is included. Exact
  // boundary times such as 14:00 are already exclusive and must not be extended.
  if (Number(endMinute) === 59) endMinuteDate.setTime(endMinuteDate.getTime() + 60000);
  return { startAt: start, endAt: toChinaOffsetISOString(endMinuteDate) };
}

export function extractCoordinates(text: string): { x: number; y: number } | null {
  const match = text.match(/X\s*[:：]\s*(\d+(?:\.\d+)?)\s*[,，、]?\s*Y\s*[:：]\s*(\d+(?:\.\d+)?)(?![\d.])/i);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
}

export function resolveLocation(
  id: string,
  coordinates: { x: number; y: number } | null,
  overrides = loadCollectorConfiguration().overrides,
) {
  const override = overrides.locations[id];
  if (!override) throw new Error(`missing LOCATION_OVERRIDES entry for event: ${id}`);
  return coordinates
    ? { ...override, displayX: coordinates.x, displayY: coordinates.y }
    : override;
}

export function resolveRewards(
  id: string,
  extracted: EventReward[],
  overrides = loadCollectorConfiguration().overrides,
): EventReward[] {
  const value = overrides.rewards[id];
  if (value === undefined) return extracted;
  if (!Array.isArray(value)) throw new Error(`invalid REWARD_OVERRIDES entry for event: ${id}`);
  return value as EventReward[];
}

export function resolveCompletion(id: string, overrides = loadCollectorConfiguration().overrides): {
  questId?: number | null;
  achievementId?: number | null;
  teleport?: TeleportTarget | null;
} {
  const value = overrides.completion[id];
  if (value === undefined) return {};
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new Error(`invalid COMPLETION_OVERRIDES entry for event: ${id}`);
  return value as { questId?: number | null; achievementId?: number | null; teleport?: TeleportTarget | null };
}

export async function extractRewards(page: Page): Promise<EventReward[]> {
  const rewardCandidates = page.locator("[data-tooltip], [data-original-title], [class*='reward'] [title], [class*='reward'] [aria-label], [class*='reward'] img, a[data-fancybox='minion'] img, a[data-fancybox='weapon'] img");
  const rewards = new Map<string, EventReward>();
  // A page may contain navigation icons with labels. Limiting probes bounds the work while
  // still covering the reward groups used by official seasonal-event pages.
  const count = Math.min(await rewardCandidates.count(), 120);
  for (let index = 0; index < count; index++) {
    const candidate = rewardCandidates.nth(index);
    const attributes = await candidate.evaluate(element => ({
      name: element.getAttribute("data-tooltip") || element.getAttribute("data-original-title") || element.getAttribute("title") || element.getAttribute("aria-label") || element.getAttribute("alt") || "",
      category: element.getAttribute("data-category") ||
        (element.closest("[data-fancybox='minion']") ? "宠物" : element.closest("[data-fancybox='weapon']") ? "武器" : ""),
      isHeading: Boolean(element.closest("h1,h2,h3,h4,h5,h6")),
    }));
    const name = attributes.name.trim();
    if (!name || attributes.isHeading || /^(?:坐骑|防具|发型|其他|奖励|活动奖励|道具|物品|宠物|武器)$/.test(name)) continue;
    if (rewards.has(name)) continue;

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

  // Exchange lists sometimes expose names only as table text, with unnamed
  // icons. Only inspect tables that explicitly identify an item/reward column.
  const tableNames = await page.locator("table").evaluateAll(tables => tables.slice(0, 20).flatMap(table => {
    const header = table.querySelector("thead")?.textContent || table.querySelector("tr")?.textContent || "";
    if (!/(?:可交换道具|奖励道具|道具名称|物品名称)/.test(header)) return [];
    return Array.from(table.querySelectorAll("tbody tr")).slice(0, 120).map(row => {
      const cell = row.querySelector("th,td");
      const label = cell?.querySelector("[class*='name']");
      return (label?.textContent || cell?.textContent || "").replace(/\s+/g, " ").trim();
    });
  }));
  for (const name of tableNames) {
    if (name && name.length <= 200 && !rewards.has(name)) rewards.set(name, { name, category: "", description: "", flags: [] });
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
  const activityQuest = text.match(/(?:接取|接受|完成)(?:本次)?活动任务\s*[「“"]([^」”"\n]+)[」”"]/);
  if (activityQuest?.[1]) return activityQuest[1].trim();
  const line = text.split(/\r?\n/)
    .map(value => value.trim())
    .find(value => /^任务(?:名称)?\s*[:：]\s*\S/.test(value));
  const explicitName = line?.replace(/^任务(?:名称)?\s*[:：]\s*/, "").trim();
  if (explicitName) return explicitName;
  // Seasonal templates put the quest heading before its acceptance conditions,
  // sometimes with one NPC introduction in between. A document title alone is
  // not evidence of the quest name (collaborations use different quest names).
  const lines = text.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const index = lines.indexOf(title);
  if (!title || index < 0) return null;
  const following = lines.slice(index + 1, index + 4);
  const conditions = following.findIndex(line => /^(?:接受|接取)(?:任务)?条件$/.test(line));
  return conditions === 0 || (conditions > 0 && following.slice(0, conditions).some(line => extractNpc(line))) ? title : null;
}

export function extractNpc(text: string): string | null {
  for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const quoted = line.match(/NPC\s*[:：]?\s*["“]([^"”\n]{2,40})["”]/i);
    if (quoted?.[1]) return cleanNpcName(quoted[1]);
    const labeled = line.match(/NPC\s*[:：]?\s*([^，。\s"“”]{2,24}?)(?=对话|交谈|接取|，|。|\s|$)/i);
    if (labeled?.[1]) return cleanNpcName(labeled[1]);
    if (/(?:活动期间|任务|接取|所在地)/.test(line)) {
      const appeared = line.match(/(?:会)?出现的?(.{2,30}?)(?=对话|交谈|。|所在地)/);
      if (appeared?.[1]) return cleanNpcName(appeared[1]);
    }
    const sentence = line.match(/^[^。\n]{1,50}?的(.{2,40}?)(?:好像有事情|好像有事|有点|有事情|有事|有话|似乎|想要|想找|想请|在寻找|正在|希望|需要)/);
    if (sentence?.[1]) return cleanNpcName(sentence[1]);
  }

  return null;
}

function cleanNpcName(value: string): string {
  return value.trim()
    .replace(/^[\s，,。；;：:]+|[\s，,。；;：:]+$/g, "")
    .replace(/^冒险者行会的/, "")
    .replace(/^红莲节执行委员(?=.{2,24}[·・].{2,24}$)/, "")
    .replace(/有活动$/, "")
    .replace(/好像$/, "");
}

function extractLevel(text: string): number | null {
  const match = text.match(/等级(?:提升至|升至)?\s*(\d+)|任意职业\s*(\d+)级/);
  return match ? Number(match[1] ?? match[2]) : null;
}

export function selectEventTitle(values: string[], documentTitle = ""): string | null {
  const title = values
    .map(value => value.trim())
    .find(value => value &&
      !/^(?:SEASONAL EVENT|季节活动|活動獎勵|活动奖励|接受(?:任务)?条件|接取(?:任务)?条件|活动概要|活动介绍|活动时间|举办时间|参加方法|活动参加方法|道具兑换|交换奖励道具|参加活动前的准备流程)$/i.test(value) &&
      !/^(?:关于|在《|将角色|完成(?:活动|主线|支线)任务|游玩联动任务|去获得|去收集|什么是)/.test(value));
  if (title) return title;
  const fallback = documentTitle.split(/\s*[|｜]\s*/)[0].trim();
  return fallback && !/^(?:《?最终幻想14》?官方网站|最终幻想14|FINAL FANTASY XIV)$/i.test(fallback) ? fallback : null;
}

function pad(value: string): string { return value.padStart(2, "0"); }

function dateBoundary(year: string, month: string, day: string, hour: string, minute: string): string | null {
  const [y, m, d, h, min] = [year, month, day, hour, minute].map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59) return null;
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) return null;
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${minute}:00+08:00`;
}

function toChinaOffsetISOString(value: Date): string {
  return new Date(value.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace(".000Z", "+08:00");
}
