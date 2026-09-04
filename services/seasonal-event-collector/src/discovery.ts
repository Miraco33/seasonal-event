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
}

const seasonalKeywords = [
  "季节活动", "降神节", "恋人节", "女儿节", "彩蛋狩猎", "金碟", "红莲节", "新生庆典", "守护天节", "星芒节",
  "heavensturn", "valentione", "littleladies", "hatching", "makeitrain", "goldsaucer", "moonfire", "therising", "allsaints", "starlight",
];

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
      links.push(...await discoverFromSdoNewsApi(discoveryUrl, networkOptions, newsPublishedAfter));
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

async function discoverFromSdoNewsApi(
  discoveryUrl: string,
  networkOptions: NetworkOptions,
  newsPublishedAfter?: Date,
): Promise<CandidateLink[]> {
  const listing = await fetchJsonWithRetry(discoveryUrl, networkOptions);
  if (!isRecord(listing) || listing.Code !== "0" || !Array.isArray(listing.Data)) {
    throw new Error("official news list returned an unsupported response");
  }

  const links: CandidateLink[] = [];
  for (const entry of selectSeasonalNewsEntries(listing.Data, newsPublishedAfter)) {
    const title = entry.title;
    const directLink = entry.outLink;
    if (directLink) {
      links.push({ href: directLink, text: title, discoveredFrom: discoveryUrl, sourceType: "discovered" });
      continue;
    }

    const detailUrl = `https://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=${entry.id}`;
    const detail = await fetchJsonWithRetry(detailUrl, networkOptions);
    if (!isRecord(detail) || detail.Code !== "0" || !isRecord(detail.Data)) {
      throw new Error(`official news detail returned an unsupported response: ${entry.id}`);
    }
    for (const href of extractSeasonalDetailLinks(detail.Data)) {
      links.push({ href, text: title, discoveredFrom: detailUrl, sourceType: "discovered" });
    }
  }
  return links;
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
    if (!isRecord(entry) || typeof entry.Title !== "string" || !/^【季节活动】/.test(entry.Title)) continue;
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

export function parseSdoPublishDate(value: string): Date | null {
  const match = value.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const result = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second),
  ));
  return Number.isFinite(result.getTime()) ? result : null;
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
    const matchedKeywords = seasonalKeywords.filter(keyword => haystack.includes(keyword.toLowerCase()));
    if (sourceType === "discovered" && matchedKeywords.length === 0) continue;

    const candidate: DiscoveryCandidate = {
      url,
      title: link.text.trim(),
      discoveredFrom: link.discoveredFrom,
      sourceType,
      matchedKeywords,
      reviewStatus: "pending",
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

function candidateUrlKey(value: string): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
