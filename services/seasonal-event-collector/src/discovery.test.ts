import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverFromSdoNewsApi,
  extractAnnouncementText,
  extractSeasonalDetailLinks,
  parseSdoPublishDate,
  selectCandidateLinks,
  selectSeasonalNewsEntries,
} from "./discovery.js";

const newsListUrl = "https://cqnews.web.sdo.com/api/news/newsList?gameCode=ff&pageIndex=0&pageSize=20";
const activityHost = "actff1.web.sdo.com";
const realAnnouncements = [
  {
    Id: 393210, Title: "《最终幻想14》x 《最终幻想15》联动再启！", PublishDate: "2026/09/17 16:36:09", SortIndex: 0,
    OutLink: "https://actff1.web.sdo.com/project/20260915ffxv/index.html",
  },
  {
    Id: 393660, Title: "FF14 x 「糖豆人」联动复刻限时开启！", PublishDate: "2026/09/30 17:03:43", SortIndex: 0,
    OutLink: "https://actff1.web.sdo.com/project/20260928ff14fallguys/4kkmxknj3rno/index.html",
  },
  {
    Id: 391316, Title: "【季节活动】妖怪手表联动再启 艾欧泽亚大集合啦喵！", PublishDate: "2026/07/28 17:43:10", SortIndex: 0,
    OutLink: "https://actff1.web.sdo.com/project/20260715youkai-watch/vaz1gqm16a3h/index.html",
  },
  {
    Id: 392697, Title: "莫古莫古★大收集 ~天文的行路 第1阶段~ 限时开启！", PublishDate: "2026/09/02 17:51:16", SortIndex: 0,
    OutLink: "https://actff1.web.sdo.com/project/20260826mogmog/0by196dc8ija/index.html",
  },
];

function ordinaryNews(id: number, date = "2026/09/30 10:00:00") {
  return { Id: id, Title: "维护公告", PublishDate: date, SortIndex: 0, OutLink: "" };
}

function fixtureFetcher(
  pages: Record<number, unknown[] | Error>,
  details: Record<number, unknown | Error> = {},
  requested: string[] = [],
) {
  return async (value: string): Promise<unknown> => {
    requested.push(value);
    const url = new URL(value);
    if (url.pathname.endsWith("newsList")) {
      const page = pages[Number(url.searchParams.get("pageIndex"))] ?? [];
      if (page instanceof Error) throw page;
      return { Code: "0", Data: page, PageCount: 126 };
    }
    const detail = details[Number(url.searchParams.get("id"))] ?? { Code: "0", Data: { Content: "", OutLink: "" } };
    if (detail instanceof Error) throw detail;
    return detail;
  };
}

test("selects real seasonal and in-game crossover announcements without admitting Mog collection", () => {
  const entries = selectSeasonalNewsEntries(realAnnouncements, new Date("2026-04-05T00:00:00Z"));
  assert.deepEqual(entries.map(entry => entry.id), [393210, 393660, 391316]);
  assert.equal(entries[2].publishedAt, "2026-07-28T09:43:10.000Z");
  const candidates = selectCandidateLinks(entries.map(entry => ({
    href: entry.outLink, text: entry.title, discoveredFrom: newsListUrl,
  })), [], [], [activityHost]);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every(candidate => candidate.reviewStatus === "pending"));
});

test("continues respecting an explicit discovery cutoff for genuinely old announcements", () => {
  const entries = selectSeasonalNewsEntries([
    { Id: 3, Title: "普通运营活动", PublishDate: "2026/09/03 10:00:00", OutLink: "" },
    { Id: 2, Title: "【季节活动】过旧活动", PublishDate: "2026/07/28 10:00:00", OutLink: "" },
    { Id: 1, Title: "【季节活动】星芒节", PublishDate: "2026/09/03 10:00:00", OutLink: "" },
  ], new Date("2026-08-05T00:00:00Z"));

  assert.deepEqual(entries, [{
    id: 1,
    title: "【季节活动】星芒节",
    outLink: "",
    publishedAt: "2026-09-03T02:00:00.000Z",
  }]);
});

test("excludes commercial, community and offline crossovers before extracting their detail pages", () => {
  const excludedTitles = [
    "【季节活动】莫古莫古★大收集限时开启！", "FF14商城联动道具限时开启", "FF14联动充值活动开启",
    "FF14联动周边活动开启", "FF14线下联动活动开启", "FF14社区联动活动开启", "FF14联动咖啡快闪活动开启",
    "FF14游戏内联动直播活动开启", "普通运营活动", "最终幻想14 x 最终幻想15制作人访谈", "糖豆人维护公告",
    "FF14 x 肯德基联动限时开启", "FF14 x 新品牌联动活动开启", "金碟游乐场玩法指南",
  ];
  assert.deepEqual(selectSeasonalNewsEntries(excludedTitles.map((Title, Id) => ({
    Id, Title, PublishDate: "2026/09/30 17:03:43", OutLink: "",
  }))), []);
});

test("accepts an explicitly identified in-game crossover and a named Gold Saucer celebration", () => {
  const entries = selectSeasonalNewsEntries([
    { Id: 1, Title: "FF14游戏内联动活动限时开启", PublishDate: "2026/09/30 17:03:43" },
    { Id: 2, Title: "金碟游乐场庆典开启", PublishDate: "2026/09/30 17:03:43" },
  ]);
  assert.deepEqual(entries.map(entry => entry.id), [1, 2]);
});

test("reports malformed metadata of an otherwise supported announcement", () => {
  assert.throws(() => selectSeasonalNewsEntries([{ ...realAnnouncements[0], PublishDate: "not-a-date" }]), /invalid publish date/);
  assert.throws(() => selectSeasonalNewsEntries([{ ...realAnnouncements[0], Id: "393210" }]), /numeric Id/);
  assert.throws(() => selectSeasonalNewsEntries([], new Date("invalid")), /valid date/);
});

test("extracts official activity links from the news detail response", () => {
  assert.deepEqual(extractSeasonalDetailLinks({
    OutLink: "",
    Content: '<p><a href="https://actff1.web.sdo.com/project/starlight/">查看详情</a></p>',
  }), ["https://actff1.web.sdo.com/project/starlight/"]);
  assert.equal(parseSdoPublishDate("2026/08/20 16:37:24")?.toISOString(), "2026-08-20T08:37:24.000Z");
  assert.equal(parseSdoPublishDate("2026/02/30 16:37:24"), null);
  assert.equal(parseSdoPublishDate("2026/09/30 24:00:00"), null);
  assert.equal(parseSdoPublishDate("2024/02/29 00:00:00")?.toISOString(), "2024-02-28T16:00:00.000Z");
});

test("discovered and manual links stay pending and never duplicate approved or ignored sources", () => {
  const candidates = selectCandidateLinks([
    {
      href: "https://actff1.web.sdo.com/project/current/",
      text: "【季节活动】当前活动",
      discoveredFrom: "https://example.com/news",
    },
    {
      href: "https://actff1.web.sdo.com/project/starlight/index.html?tracking=1",
      text: "【季节活动】星芒节",
      discoveredFrom: "https://example.com/news",
    },
    {
      href: "https://actff1.web.sdo.com/project/promotion/",
      text: "普通运营活动",
      discoveredFrom: "https://example.com/news",
    },
    {
      href: "https://actff1.web.sdo.com/project/manual/",
      text: "",
      discoveredFrom: "versioned-candidate-list",
      sourceType: "manual",
    },
  ], ["https://actff1.web.sdo.com/project/current/index.html"], [
    "https://actff1.web.sdo.com/project/ignored/",
  ], ["actff1.web.sdo.com"]);

  assert.deepEqual(candidates.map(candidate => ({ url: candidate.url, status: candidate.reviewStatus })), [
    { url: "https://actff1.web.sdo.com/project/manual/", status: "pending" },
    { url: "https://actff1.web.sdo.com/project/starlight/index.html", status: "pending" },
  ]);
});

test("keeps discovery restricted to official-host project pages and excludes Mog URLs", () => {
  const links = [
    { href: "https://actff1.web.sdo.com/news/ffxv.html", text: realAnnouncements[0].Title, discoveredFrom: newsListUrl },
    { href: "https://untrusted.example/project/ffxv/", text: realAnnouncements[0].Title, discoveredFrom: newsListUrl },
    { href: realAnnouncements[3].OutLink, text: "【季节活动】联动再启", discoveredFrom: newsListUrl },
    { href: "https://actff1.web.sdo.com/project/promotion/", text: "联动开启", discoveredFrom: newsListUrl },
    { href: realAnnouncements[0].OutLink, text: realAnnouncements[0].Title, discoveredFrom: newsListUrl },
  ];
  assert.deepEqual(selectCandidateLinks(links, [], [], [activityHost]).map(candidate => candidate.url), [realAnnouncements[0].OutLink]);
});

test("reads past old pinned news and deduplicates IDs across pages before ending at an entirely old ordinary page", async () => {
  const requested: string[] = [];
  const oldPinned = { ...realAnnouncements[2], SortIndex: 5 };
  const fetchJson = fixtureFetcher({
    0: [oldPinned, ordinaryNews(10, "2026/07/01 10:00:00")],
    1: [oldPinned, realAnnouncements[0]],
    2: [ordinaryNews(11, "2026/07/01 10:00:00"), ordinaryNews(12, "2026/07/01 09:00:00")],
  }, {}, requested);
  const result = await discoverFromSdoNewsApi(newsListUrl.replace("pageSize=20", "pageSize=2"), {}, new Date("2026-08-31T00:00:00Z"), fetchJson);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.links.map(link => link.href), [realAnnouncements[0].OutLink]);
  assert.deepEqual(requested.filter(url => url.includes("newsList")).map(url => new URL(url).searchParams.get("pageIndex")), ["0", "1", "2"]);
  assert.equal(requested.filter(url => url.includes("newsDetail")).length, 1);
});

test("scans beyond old entries when ordinary sorting metadata cannot be established", async () => {
  const old = { ...ordinaryNews(10, "2026/07/01 10:00:00"), SortIndex: undefined };
  const result = await discoverFromSdoNewsApi(newsListUrl.replace("pageSize=20", "pageSize=1"), {}, new Date("2026-08-31T00:00:00Z"), fixtureFetcher({
    0: [old], 1: [realAnnouncements[0]], 2: [],
  }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.links[0].href, realAnnouncements[0].OutLink);
});

test("ends an established old ordinary window without treating the older archive as an incomplete scan", async () => {
  const requested: string[] = [];
  const result = await discoverFromSdoNewsApi(newsListUrl.replace("pageSize=20", "pageSize=1"), {}, new Date("2026-04-05T00:00:00Z"), fixtureFetcher({
    0: [ordinaryNews(10, "2026/03/01 10:00:00")], 1: new Error("must not request older archive"),
  }, {}, requested));
  assert.deepEqual(result, { links: [], errors: [] });
  assert.equal(requested.length, 1);
});

test("retains discovered candidates when a later page fails", async () => {
  const result = await discoverFromSdoNewsApi(newsListUrl.replace("pageSize=20", "pageSize=1"), {}, undefined, fixtureFetcher({
    0: [realAnnouncements[0]], 1: new Error("HTTP 503"),
  }));
  assert.equal(result.links[0].href, realAnnouncements[0].OutLink);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].url, /pageIndex=1/);
  assert.match(result.errors[0].message, /503/);
});

test("retains a verified direct link and reports failure when its announcement detail cannot be read", async () => {
  const result = await discoverFromSdoNewsApi(newsListUrl, {}, undefined, fixtureFetcher({ 0: [realAnnouncements[0]] }, {
    393210: new Error("detail unavailable"),
  }));
  assert.equal(result.links[0].href, realAnnouncements[0].OutLink);
  assert.equal(result.links[0].announcementText, undefined);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].url, /newsDetail.*id=393210/);
});

test("continues processing independent announcements after a detail failure", async () => {
  const result = await discoverFromSdoNewsApi(newsListUrl, {}, undefined, fixtureFetcher({
    0: [{ ...realAnnouncements[0], OutLink: "" }, realAnnouncements[1]],
  }, { 393210: { Code: "1", Data: null } }));
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].href, realAnnouncements[1].OutLink);
  assert.equal(result.errors.length, 1);
});

test("detects repeated pagination and does not repeatedly load the same announcement", async () => {
  const requested: string[] = [];
  const result = await discoverFromSdoNewsApi(newsListUrl.replace("pageSize=20", "pageSize=1"), {}, undefined, fixtureFetcher({
    0: [realAnnouncements[0]], 1: [realAnnouncements[0]],
  }, {}, requested));
  assert.equal(result.links.length, 1);
  assert.equal(requested.filter(url => url.includes("newsDetail")).length, 1);
  assert.match(result.errors[0].message, /repeated a page/);
});

test("deduplicates IDs within one page", async () => {
  const requested: string[] = [];
  const result = await discoverFromSdoNewsApi(newsListUrl, {}, undefined, fixtureFetcher({
    0: [realAnnouncements[0], realAnnouncements[0]],
  }, {}, requested));
  assert.deepEqual(result.errors, []);
  assert.equal(result.links.length, 1);
  assert.equal(requested.filter(url => url.includes("newsDetail")).length, 1);
});

test("bounds pagination and explicitly reports a truncated discovery window", async () => {
  const pages: Record<number, unknown[]> = {};
  for (let page = 0; page < 21; page++) pages[page] = [ordinaryNews(1000 + page)];
  const requested: string[] = [];
  const result = await discoverFromSdoNewsApi(newsListUrl.replace("pageSize=20", "pageSize=1"), {}, undefined, fixtureFetcher(pages, {}, requested));
  assert.equal(requested.length, 20);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /20-page limit/);
});

test("caps large page sizes and rejects invalid pagination parameters", async () => {
  const requested: string[] = [];
  await discoverFromSdoNewsApi(newsListUrl.replace("pageSize=20", "pageSize=2500"), {}, undefined, fixtureFetcher({}, {}, requested));
  assert.equal(new URL(requested[0]).searchParams.get("pageSize"), "100");
  await assert.rejects(discoverFromSdoNewsApi(newsListUrl.replace("pageIndex=0", "pageIndex=-1"), {}, undefined, fixtureFetcher({})), /pagination/);
});

test("extracts authoritative announcement text while preserving real dates and discarding scripts", () => {
  const text = extractAnnouncementText({
    Content: '<p>FF14 x 「糖豆人」联动复刻限时开启！</p><p>2026年9月30日 14:00 ～ 2026年10月20日 14:00</p><script>fake dates</script><style>fake dates</style><p>&#x5956;&#21169;&nbsp;&amp;&nbsp;地图</p>',
  });
  assert.equal(text, "FF14 x 「糖豆人」联动复刻限时开启！\n2026年9月30日 14:00 ～ 2026年10月20日 14:00\n奖励 & 地图");
  assert.equal(extractAnnouncementText({}), "");
});

test("preserves official announcement metadata even when a list entry already has a direct project link", async () => {
  const detailUrl = "https://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=393660";
  const result = await discoverFromSdoNewsApi(newsListUrl, {}, undefined, fixtureFetcher({ 0: [realAnnouncements[1]] }, {
    393660: { Code: "0", Data: { Content: `<p>2026年9月30日 14:00 ～ 2026年10月20日 14:00</p><a href="${realAnnouncements[1].OutLink}">活动详情</a>` } },
  }));
  assert.equal(result.links.length, 1);
  const candidates = selectCandidateLinks(result.links, [], [], [activityHost]);
  assert.equal(candidates[0].announcementUrl, detailUrl);
  assert.match(candidates[0].announcementText ?? "", /2026年10月20日/);
  assert.equal(candidates[0].title, realAnnouncements[1].Title);
});

test("prefers the official direct activity URL over unrelated project links inside announcement content", async () => {
  const result = await discoverFromSdoNewsApi(newsListUrl, {}, undefined, fixtureFetcher({ 0: [realAnnouncements[0]] }, {
    393210: { Code: "0", Data: { Content: '<p>活动详情</p><a href="https://actff1.web.sdo.com/project/promotion/">另一个运营页面</a>' } },
  }));
  assert.deepEqual(result.links.map(link => link.href), [realAnnouncements[0].OutLink]);
});

test("discards announcement metadata from nonofficial or mismatched sources", () => {
  for (const announcementUrl of ["https://untrusted.example/newsDetail?id=393210", "http://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=393210"]) {
    const candidates = selectCandidateLinks([{
      href: realAnnouncements[0].OutLink, text: realAnnouncements[0].Title, discoveredFrom: announcementUrl,
      announcementUrl, announcementText: "unverified dates",
    }], [], [], [activityHost]);
    assert.equal(candidates[0].announcementUrl, undefined);
    assert.equal(candidates[0].announcementText, undefined);
  }
  const candidates = selectCandidateLinks([{
    href: realAnnouncements[0].OutLink, text: realAnnouncements[0].Title, discoveredFrom: newsListUrl,
    announcementUrl: "https://cqnews.web.sdo.com/api/news/newsDetail?gameCode=ff&id=393210", announcementText: "unverified dates",
  }], [], [], [activityHost]);
  assert.equal(candidates[0].announcementText, undefined);
});
