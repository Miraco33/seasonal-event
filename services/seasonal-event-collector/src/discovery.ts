import { chromium } from "playwright";
import type { NetworkOptions } from "./network.js";
import { navigateWithRetry, retryOperation } from "./network.js";

export interface DiscoveryCandidate {
  url: string;
  title: string;
  discoveredFrom: string;
  sourceType: "discovered" | "manual";
  matchedKeywords: string[];
  reviewStatus: "pending";
  announcementUrl?: string;
  announcementText?: string;
}

export interface DiscoveryError {
  url: string;
  message: string;
}

export interface DiscoveryResult {
  candidates: DiscoveryCandidate[];
  errors: DiscoveryError[];
}

export interface CandidateLink {
  href: string;
  text: string;
  discoveredFrom: string;
  sourceType?: "discovered" | "manual";
  announcementUrl?: string;
  announcementText?: string;
}

const seasonalKeywords = [
  "季节活动", "降神节", "恋人节", "女儿节", "彩蛋狩猎", "金碟", "红莲节", "新生庆典", "守护天节", "星芒节",
  "heavensturn", "valentione", "littleladies", "hatching", "makeitrain", "goldsaucer", "moonfire", "therising", "allsaints", "starlight",
];
const crossoverKeywords = ["联动", "最终幻想15", "最终幻想xv", "ffxv", "ff15", "糖豆人", "fallguys", "fall guys", "妖怪手表", "youkai-watch", "yokai-watch"];
const excludedActivityPattern = /莫古.{0,6}(?:大收集|收集)|mogmog|mogtome|商城|充值|点卡|周边|线下|社区|快闪|咖啡|联名|商品销售|直播|征集|维护公告|停机维护|客户端更新/i;
const maxNewsPages = 20;
const maxNewsPageSize = 100;

export interface NewsDiscoveryResult {
  links: CandidateLink[];
  errors: DiscoveryError[];
}

export async function discoverCandidatePages(
  discoveryUrls: string[],
  approvedUrls: string[],
  pendingUrls: string[],
  ignoredUrls: string[],
  allowedHosts: string[],
  networkOptions: NetworkOptions = {},
  newsPublishedAfter?: Date,
): Promise<DiscoveryResult> {
  const links: CandidateLink[] = pendingUrls.map(url => ({
    href: url,
    text: "",
    discoveredFrom: "versioned-or-environment-candidate-list",
    sourceType: "manual",
  }));
  const errors: DiscoveryError[] = [];
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  const htmlDiscoveryUrls = discoveryUrls.filter(url => !isSdoNewsListApi(url));

  for (const discoveryUrl of discoveryUrls.filter(isSdoNewsListApi)) {
    try {
      const discovery = await discoverFromSdoNewsApi(discoveryUrl, networkOptions, newsPublishedAfter);
      links.push(...discovery.links);
      errors.push(...discovery.errors);
    } catch (error) {
      errors.push({ url: discoveryUrl, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (htmlDiscoveryUrls.length > 0) {
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage({ locale: "zh-CN", timezoneId: "Asia/Shanghai" });
      for (const discoveryUrl of htmlDiscoveryUrls) {
        try {
          await navigateWithRetry(page, discoveryUrl, networkOptions);
          await page.waitForTimeout(800);
          const pageLinks = await page.locator("a[href]").evaluateAll(elements => elements.map(element => ({
            href: element.getAttribute("href") || "",
            text: (element.textContent || "").trim(),
          })));
          links.push(...pageLinks.map(link => ({ ...link, discoveredFrom: discoveryUrl, sourceType: "discovered" as const })));
        } catch (error) {
          errors.push({ url: discoveryUrl, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally {
      await browser.close();
    }
  }

  return {
    candidates: selectCandidateLinks(links, approvedUrls, ignoredUrls, allowedHosts),
    errors,
  };
}

export async function discoverFromSdoNewsApi(
  discoveryUrl: string,
  networkOptions: NetworkOptions = {},
  newsPublishedAfter?: Date,
  fetchJson: (url: string, options: NetworkOptions) => Promise<unknown> = fetchJsonWithRetry,
): Promise<NewsDiscoveryResult> {
  const listingUrl = new URL(discoveryUrl);
  const firstPage = Number(listingUrl.searchParams.get("pageIndex") ?? "0");
  const requestedPageSize = Number(listingUrl.searchParams.get("pageSize") ?? "20");
  if (!Number.isInteger(firstPage) || firstPage < 0 || !Number.isInteger(requestedPageSize) || requestedPageSize < 1) {
    throw new Error("official news pagination requires a non-negative pageIndex and a positive pageSize");
  }
  const pageSize = Math.min(requestedPageSize, maxNewsPageSize);
  listingUrl.searchParams.set("pageSize", String(pageSize));
  const cutoff = newsPublishedAfter?.getTime();
  if (cutoff !== undefined && !Number.isFinite(cutoff)) throw new Error("news discovery cutoff must be a valid date");
  const links: CandidateLink[] = [];
  const errors: DiscoveryError[] = [];
  const seenNewsIds = new Set<number>();

  for (let offset = 0; offset < maxNewsPages; offset++) {
    listingUrl.searchParams.set("pageIndex", String(firstPage + offset));
    const pageUrl = listingUrl.href;
    let entries: unknown[];
    try {
      const listing = await fetchJson(pageUrl, networkOptions);
      if (!isRecord(listing) || listing.Code !== "0" || !Array.isArray(listing.Data)) {
        throw new Error("official news list returned an unsupported response");
      }
      entries = listing.Data;
    } catch (error) {
      errors.push({ url: pageUrl, message: error instanceof Error ? error.message : String(error) });
      break;
    }
    if (entries.length === 0) break;

    const unseenEntries: unknown[] = [];
    for (const entry of entries) {
      if (isRecord(entry) && Number.isInteger(entry.Id)) {
        if (seenNewsIds.has(entry.Id as number)) continue;
        seenNewsIds.add(entry.Id as number);
      }
      unseenEntries.push(entry);
    }
    let selectedEntries: ReturnType<typeof selectSeasonalNewsEntries>;
    try {
      selectedEntries = selectSeasonalNewsEntries(unseenEntries, newsPublishedAfter);
    } catch (error) {
      errors.push({ url: pageUrl, message: error instanceof Error ? error.message : String(error) });
      break;
    }
    for (const entry of selectedEntries) {
      const detailUrl = `https://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=${entry.id}`;
      try {
        const detail = await fetchJson(detailUrl, networkOptions);
        if (!isRecord(detail) || detail.Code !== "0" || !isRecord(detail.Data)) {
          throw new Error(`official news detail returned an unsupported response: ${entry.id}`);
        }
        const announcementText = extractAnnouncementText(detail.Data);
        const directLink = entry.outLink || (typeof detail.Data.OutLink === "string" ? detail.Data.OutLink.trim() : "");
        const detailLinks = directLink ? [directLink] : [...new Set(extractSeasonalDetailLinks(detail.Data))];
        for (const href of detailLinks) {
          links.push({
            href,
            text: entry.title,
            discoveredFrom: detailUrl,
            sourceType: "discovered",
            announcementUrl: detailUrl,
            ...(announcementText ? { announcementText } : {}),
          });
        }
      } catch (error) {
        if (entry.outLink) links.push({ href: entry.outLink, text: entry.title, discoveredFrom: pageUrl, sourceType: "discovered" });
        errors.push({ url: detailUrl, message: error instanceof Error ? error.message : String(error) });
      }
    }

    // The API orders ordinary news by publication time. A pinned old item alone
    // must never terminate scanning; require an entire ordinary page past the cutoff.
    const entirelyOlderOrdinaryPage = cutoff !== undefined && entries.every(entry => {
      if (!isRecord(entry) || entry.SortIndex !== 0 || typeof entry.PublishDate !== "string") return false;
      const publishedAt = parseSdoPublishDate(entry.PublishDate);
      return publishedAt !== null && publishedAt.getTime() < cutoff;
    });
    if (entries.length < pageSize || entirelyOlderOrdinaryPage) break;
    if (unseenEntries.length === 0) {
      errors.push({ url: pageUrl, message: "official news pagination repeated a page; discovery scan is incomplete" });
      break;
    }
    if (offset === maxNewsPages - 1) {
      errors.push({ url: pageUrl, message: `official news discovery reached the ${maxNewsPages}-page limit; discovery scan is incomplete` });
    }
  }
  return { links, errors };
}

async function fetchJsonWithRetry(url: string, options: NetworkOptions): Promise<unknown> {
  return retryOperation(async () => {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "seasonal-event-collector" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
    return response.json() as Promise<unknown>;
  }, {
    attempts: options.attempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? 1000,
    onRetry: diagnostic => options.onRetry?.({ url, ...diagnostic }),
  });
}

export function selectSeasonalNewsEntries(
  entries: unknown[],
  publishedAfter?: Date,
): Array<{ id: number; title: string; outLink: string; publishedAt: string }> {
  const cutoff = publishedAfter?.getTime();
  if (cutoff !== undefined && !Number.isFinite(cutoff)) throw new Error("news discovery cutoff must be a valid date");
  const result: Array<{ id: number; title: string; outLink: string; publishedAt: string }> = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.Title !== "string" || !isSupportedActivity(entry.Title)) continue;
    if (!Number.isInteger(entry.Id)) throw new Error(`seasonal news entry has no numeric Id: ${entry.Title}`);
    if (typeof entry.PublishDate !== "string") throw new Error(`seasonal news entry has no publish date: ${entry.Title}`);
    const publishedAt = parseSdoPublishDate(entry.PublishDate);
    if (!publishedAt) throw new Error(`seasonal news entry has an invalid publish date: ${entry.Title}`);
    if (cutoff !== undefined && publishedAt.getTime() < cutoff) continue;
    result.push({
      id: entry.Id as number,
      title: entry.Title.trim(),
      outLink: typeof entry.OutLink === "string" ? entry.OutLink.trim() : "",
      publishedAt: publishedAt.toISOString(),
    });
  }
  return result;
}

export function extractSeasonalDetailLinks(detail: Record<string, unknown>): string[] {
  const links: string[] = [];
  if (typeof detail.OutLink === "string" && detail.OutLink.trim()) links.push(detail.OutLink.trim());
  if (typeof detail.Content === "string") links.push(...extractHtmlLinks(detail.Content));
  return links;
}

export function extractAnnouncementText(detail: Record<string, unknown>): string {
  if (typeof detail.Content !== "string") return "";
  return detail.Content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, name: string) => ({
      nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">",
    })[name.toLowerCase()] ?? "")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, value: string) => {
      const point = value[0].toLowerCase() === "x" ? Number.parseInt(value.slice(1), 16) : Number(value);
      return point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    })
    .replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim().slice(0, 100000);
}

export function parseSdoPublishDate(value: string): Date | null {
  const match = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const result = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second),
  ));
  const chinaClock = new Date(result.getTime() + 8 * 3_600_000);
  return chinaClock.getUTCFullYear() === Number(year) && chinaClock.getUTCMonth() === Number(month) - 1 &&
    chinaClock.getUTCDate() === Number(day) && chinaClock.getUTCHours() === Number(hour) &&
    chinaClock.getUTCMinutes() === Number(minute) && chinaClock.getUTCSeconds() === Number(second) ? result : null;
}

export function extractHtmlLinks(value: string): string[] {
  return [...value.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]);
}

function isSdoNewsListApi(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === "cqnews.web.sdo.com" && url.pathname.toLowerCase() === "/api/news/newslist";
  } catch {
    return false;
  }
}

export function selectCandidateLinks(
  links: CandidateLink[],
  approvedUrls: string[],
  ignoredUrls: string[],
  allowedHosts: string[],
): DiscoveryCandidate[] {
  const approved = new Set(approvedUrls.map(url => candidateUrlKey(url)));
  const ignored = new Set(ignoredUrls.map(url => candidateUrlKey(url)));
  const hosts = new Set(allowedHosts.map(host => host.trim().toLowerCase()).filter(Boolean));
  const candidates = new Map<string, DiscoveryCandidate>();

  for (const link of links) {
    const url = normalizeCandidateUrl(link.href, link.discoveredFrom);
    if (!url || !hosts.has(new URL(url).hostname.toLowerCase())) continue;
    const key = candidateUrlKey(url);
    if (approved.has(key) || ignored.has(key)) continue;

    const sourceType = link.sourceType ?? "discovered";
    const haystack = safeDecode(`${link.text} ${url}`).toLowerCase();
    if (excludedActivityPattern.test(haystack)) continue;
    const matchedKeywords = [...seasonalKeywords, ...crossoverKeywords].filter(keyword => haystack.includes(keyword.toLowerCase()));
    if (sourceType === "discovered" && (!new URL(url).pathname.startsWith("/project/") || !isSupportedActivity(haystack))) continue;

    const candidate: DiscoveryCandidate = {
      url,
      title: link.text.trim(),
      discoveredFrom: link.discoveredFrom,
      sourceType,
      matchedKeywords,
      reviewStatus: "pending",
      ...(link.announcementUrl && link.discoveredFrom === link.announcementUrl && isSdoNewsDetailApi(link.announcementUrl) ? {
        announcementUrl: link.announcementUrl,
        ...(typeof link.announcementText === "string" ? { announcementText: link.announcementText.slice(0, 100000) } : {}),
      } : {}),
    };
    const existing = candidates.get(key);
    if (!existing || (!existing.title && candidate.title)) candidates.set(key, candidate);
  }

  return [...candidates.values()].sort((left, right) => left.url.localeCompare(right.url));
}

export function normalizeCandidateUrl(value: string, base?: string): string | null {
  try {
    // An absolute candidate must remain usable even when its diagnostic source is
    // a label such as "versioned-candidate-list" rather than a URL.
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      if (!base) return null;
      url = new URL(value, base);
    }
    if (url.protocol !== "https:") return null;
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}

export function candidateUrlKey(value: string): string {
  const normalized = normalizeCandidateUrl(value);
  if (!normalized) return value.trim().toLowerCase();
  const url = new URL(normalized);
  let path = url.pathname.replace(/\/index\.html?$/i, "").replace(/\/$/, "");
  if (!path) path = "/";
  return `${url.hostname.toLowerCase()}${path.toLowerCase()}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSupportedActivity(value: string): boolean {
  const text = safeDecode(value).toLowerCase().replace(/\s+/g, " ");
  if (excludedActivityPattern.test(text)) return false;
  if (seasonalKeywords.some(keyword => keyword !== "金碟" && text.includes(keyword.toLowerCase())) ||
    /金碟(?:游乐场)?(?:庆典|狂欢|嘉年华)/.test(text)) return true;
  const hasCrossover = /联动/.test(text);
  const hasOpening = /再启|再临|再演|复刻|开启|限时|举办|回归|活动/.test(text);
  const hasGameContext = /游戏内/.test(text) ||
    crossoverKeywords.slice(1).some(keyword => text.includes(keyword));
  return hasCrossover && hasOpening && hasGameContext;
}

function isSdoNewsDetailApi(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "cqnews.web.sdo.com" &&
      url.pathname.toLowerCase() === "/api/news/newsdetail" && url.searchParams.get("gameCode") === "ff" &&
      /^\d+$/.test(url.searchParams.get("id") ?? "");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
