import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {runSite03DraftTrial} from "../scripts/lib/site-03-draft-trial.mjs";
import {readRecoveredHistory, validateRecoveredHistory, verifyRecoveredHistory} from "../scripts/lib/site-03-recovered-history.mjs";

const categories = [{id: 1, name: "Parent", parent: 0}, {id: 2, name: "A", parent: 1}, {id: 3, name: "B", parent: 1}];
const entries = [
  {title: "Already written", childCategory: "A"},
  {title: "In history", childCategory: "B"},
  {title: "First", childCategory: "A"},
  {title: "Second", childCategory: "B"},
];

function trial({categoryStatus = 200, failSecond = false, invalidDraft = false, missingChild = false, badPagination = false, missingHistory = false} = {}) {
  const calls = [];
  const reports = [];
  const created = [];
  const list = (items) => new Response(JSON.stringify(items), {headers: {
    "x-wp-totalpages": badPagination ? "2" : String(Number(items.length > 0)),
    "x-wp-total": String(items.length),
  }});
  const run = () => runSite03DraftTrial({
    entries, titleKey: (title) => title.toLowerCase(),
    readHistory: () => {
      if (missingHistory) throw new Error("missing history");
      return [{title: "In history"}];
    },
    siteBase: "https://site.example", headers: {}, report: (data) => reports.push(data),
    mapCategory: (all, entry) => all.find((category) => category.name === entry.childCategory),
    request: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path.endsWith("/categories")) return categoryStatus === 200 ? list(missingChild ? categories.slice(0, 2) : categories) : new Response(null, {status: categoryStatus});
      if (path.endsWith("/posts")) return list([
        {id: 1, title: {raw: "Already written"}}, ...created,
      ]);
      return Response.json(created.at(-1));
    },
    createDraft: async ({title, category}) => {
      calls.push("CREATE");
      if (failSecond && created.length) throw Error("mock create failure");
      const post = {id: 10 + created.length, title: {raw: title}, status: invalidDraft ? "publish" : "draft", categories: [category.id, category.parent]};
      created.push(post);
      return post;
    },
  });
  return {run, calls, reports, created};
}

test("403 prevents all writes", async () => {
  const t = trial({categoryStatus: 403});
  await assert.rejects(t.run, /403/);
  assert.deepEqual(t.calls, ["/wp-json/wp/v2/categories"]);
});

test("selects and verifies two distinct unused titles in existing child categories", async () => {
  const t = trial();
  await t.run();
  assert.deepEqual(t.created.map((p) => [p.title.raw, p.status, p.categories]), [["First", "draft", [2, 1]], ["Second", "draft", [3, 1]]]);
  assert.ok(t.calls.includes("/wp-json/wp/v2/posts/10"));
  assert.ok(t.calls.includes("/wp-json/wp/v2/posts/11"));
});

test("second write failure preserves the first result and does not retry", async () => {
  const t = trial({failSecond: true});
  await assert.rejects(t.run, /mock create failure/);
  assert.equal(t.created.length, 1);
  assert.equal(t.calls.filter((call) => call === "CREATE").length, 2);
  assert.equal(t.reports.filter((report) => report.verified).length, 1);
});

test("failed verification stops before the second write", async () => {
  const t = trial({invalidDraft: true});
  await assert.rejects(t.run);
  assert.equal(t.calls.filter((call) => call === "CREATE").length, 1);
});

test("missing child category or invalid pagination prevents writes", async () => {
  for (const options of [{missingChild: true}, {badPagination: true}]) {
    const t = trial(options);
    await assert.rejects(t.run);
    assert.ok(!t.calls.includes("CREATE"));
  }
});

test("missing creation history fails after the category GET without attempting a write", async () => {
  const t = trial({missingHistory: true});
  await assert.rejects(t.run, /missing history/);
  assert.deepEqual(t.calls, ["/wp-json/wp/v2/categories"]);
});

test("복구 이력은 로그에서 확인한 고유한 제목과 글 ID만 허용한다", () => {
  const records = [
    {ok: true, site: 3, title: "원래 제목", postId: 744, status: "draft", recovery: {source: "github-actions-log", runId: 39734583604, jobId: 119677191159}},
    {ok: true, site: 3, title: "다른 제목", postId: 746, status: "draft", recovery: {source: "github-actions-log", runId: 39734583604, jobId: 119677191159}},
  ];
  assert.deepEqual(validateRecoveredHistory(records), records);
  assert.throws(() => validateRecoveredHistory([{...records[0], ok: false}]), /성공/);
  assert.throws(() => validateRecoveredHistory([...records, {...records[0], title: "임의 제목"}]), /중복/);
});

test("복구 이력은 GitHub Actions 로그의 68개 제목과 글 ID를 보존한다", () => {
  const path = fileURLToPath(new URL("../makeit-adsense/inputs/site-03/recovered-history.json", import.meta.url));
  const records = readRecoveredHistory(path);
  assert.equal(records.length, 68);
  assert.deepEqual(records[0], {
    ok: true, site: 3, title: "벚꽃으로 유명한 세계 여행지의 기후적 특징", postId: 744, status: "draft",
    recovery: {source: "github-actions-log", runId: 39734583604, jobId: 119677191159},
  });
  assert.deepEqual(records.at(-1), {
    ok: true, site: 3, title: "대륙성 기후 여행지에서 계절별 기온 차이가 큰 이유", postId: 878, status: "draft",
    recovery: {source: "github-actions-log", runId: 39893033520, jobId: 120216970851},
  });
});

test("일회성 시험은 복구 이력의 제목을 새 글 후보에서 제외한다", async () => {
  const path = fileURLToPath(new URL("../makeit-adsense/inputs/site-03/recovered-history.json", import.meta.url));
  const recovered = readRecoveredHistory(path);
  const localEntries = [
    {title: recovered[0].title, childCategory: "A"},
    {title: "새 제목 A", childCategory: "A"},
    {title: "새 제목 B", childCategory: "B"},
  ];
  const created = [];
  const list = (items) => new Response(JSON.stringify(items), {headers: {"x-wp-totalpages": String(Number(items.length > 0)), "x-wp-total": String(items.length)}});
  await runSite03DraftTrial({
    entries: localEntries, readHistory: () => recovered, titleKey: (title) => title.toLowerCase(),
    siteBase: "https://site.example", headers: {}, report: () => {},
    mapCategory: (all, entry) => all.find((category) => category.name === entry.childCategory),
    request: async (url) => {
      const pathName = new URL(url).pathname;
      if (pathName.endsWith("/categories")) return list(categories);
      if (pathName.endsWith("/posts")) return list(created);
      return Response.json(created.find((post) => pathName.endsWith(`/${post.id}`)));
    },
    createDraft: async ({title, category}) => {
      const post = {id: 20 + created.length, title: {raw: title}, status: "draft", categories: [category.id, category.parent]};
      created.push(post);
      return post;
    },
  });
  assert.deepEqual(created.map((post) => post.title.raw), ["새 제목 A", "새 제목 B"]);
});

test("삭제되거나 제목이 바뀐 글도 원래 복구 제목은 제외 목록에 유지한다", async () => {
  const records = [
    {ok: true, site: 3, title: "원래 제목", postId: 744, status: "draft", recovery: {source: "github-actions-log", runId: 39734583604, jobId: 119677191159}},
    {ok: true, site: 3, title: "삭제된 제목", postId: 746, status: "draft", recovery: {source: "github-actions-log", runId: 39734583604, jobId: 119677191159}},
  ];
  const calls = [];
  const result = await verifyRecoveredHistory({
    siteBase: "https://site.example",
    headers: {Authorization: "Basic test-only"},
    records,
    request: async (url, options) => {
      calls.push({url, options});
      return url.includes("/744?")
        ? Response.json({id: 744, title: {raw: "변경된 제목"}, status: "publish"})
        : Response.json({code: "rest_post_invalid_id"}, {status: 404});
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.options.method === "GET"), true);
  assert.equal(result.verifiedCount, 2);
  assert.deepEqual(result.excludedTitles, ["원래 제목", "삭제된 제목"]);
  assert.deepEqual(result.changedPostIds, [744]);
  assert.deepEqual(result.deletedPostIds, [746]);
});
