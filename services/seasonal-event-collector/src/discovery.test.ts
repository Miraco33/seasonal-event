import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSeasonalDetailLinks,
  parseSdoPublishDate,
  selectCandidateLinks,
  selectSeasonalNewsEntries,
} from "./discovery.js";

test("only selects explicit seasonal announcements inside the discovery cutoff", () => {
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

test("extracts official activity links from the news detail response", () => {
  assert.deepEqual(extractSeasonalDetailLinks({
    OutLink: "",
    Content: '<p><a href="https://actff1.web.sdo.com/project/starlight/">查看详情</a></p>',
  }), ["https://actff1.web.sdo.com/project/starlight/"]);
  assert.equal(parseSdoPublishDate("2026/08/20 16:37:24")?.toISOString(), "2026-08-20T08:37:24.000Z");
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
