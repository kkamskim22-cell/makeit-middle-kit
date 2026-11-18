import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {readFileSync} from "node:fs";
import {runSite03DraftTrial} from "../scripts/lib/site-03-draft-trial.mjs";
import {readRecoveredHistory, readTrialVerifiedHistory, validateRecoveredHistory, verifyRecoveredHistory} from "../scripts/lib/site-03-recovered-history.mjs";
import {attachTrialDiagnostic, safeTrialDiagnostic, trialFailure} from "../scripts/lib/site-03-trial-diagnostics.mjs";
import {assertPlanTitleUnused, validateImageDraftPlan, verifyDraftPostRequirements, verifyImageDraftRecord} from "../scripts/lib/site-03-image-draft-plan.mjs";

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

test("검증된 시험 글 ID 965는 복구 이력과 분리해 중복 제외 목록에 보관한다", () => {
  const path = fileURLToPath(new URL("../makeit-adsense/inputs/site-03/trial-verified-history.json", import.meta.url));
  assert.deepEqual(readTrialVerifiedHistory(path), [{
    ok: true, site: 3, title: "지중해 지역 세계 여행지의 봄 풍경이 특별한 이유", postId: 965, status: "draft",
    categoryIds: [4, 5], recovery: {source: "site-03-trial-workflow", runId: 44231170375, verified: true},
  }]);
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

test("OpenAI API 오류는 HTTP 상태와 안전한 오류 코드만 진단한다", () => {
  const diagnostic = safeTrialDiagnostic(trialFailure("article_api", {httpStatus: 429, openAiCode: "rate_limit_exceeded"}), "article_generation");
  assert.deepEqual(diagnostic, {stage: "article_generation", errorType: "article_api", httpStatus: 429, openAiCode: "rate_limit_exceeded"});
  assert.equal(JSON.stringify(diagnostic).includes("secret"), false);
});

test("원본 오류 메시지는 보존하면서 안전한 진단 값만 별도로 붙인다", () => {
  const error = attachTrialDiagnostic(new Error("응답 원문은 로그에 쓰지 않는다"), "meta_response", {httpStatus: 200});
  assert.equal(error.message, "응답 원문은 로그에 쓰지 않는다");
  assert.deepEqual(safeTrialDiagnostic(error, "meta_generation"), {stage: "meta_generation", errorType: "meta_response", httpStatus: 200});
});

test("출력 중단, HTML 검증, 분량 미달을 서로 다른 안전한 진단으로 기록한다", () => {
  assert.deepEqual(
    safeTrialDiagnostic(trialFailure("article_incomplete", {finishReason: "max_output_tokens"}), "article_generation"),
    {stage: "article_generation", errorType: "article_incomplete", finishReason: "max_output_tokens"},
  );
  assert.deepEqual(
    safeTrialDiagnostic(trialFailure("article_html_invalid", {htmlRule: "missing_gutenberg_block"}), "article_validation"),
    {stage: "article_validation", errorType: "article_html_invalid", htmlRule: "missing_gutenberg_block"},
  );
  assert.deepEqual(
    safeTrialDiagnostic(trialFailure("article_too_short", {characterCount: 1200, minimumCharacterCount: 3000}), "article_validation"),
    {stage: "article_validation", errorType: "article_too_short", characterCount: 1200, minimumCharacterCount: 3000},
  );
});

test("이미지 포함 후속 계획은 제목, 4-3 카테고리, 세 이미지와 근거를 요구한다", () => {
  const plan = {
    title: "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교",
    categoryKey: "4-3",
    seo: {title: "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교", description: "안데스 산맥 서쪽의 산티아고와 동쪽의 멘도사를 계절별 기후와 여행 환경으로 비교합니다.", keyword: "안데스 산맥 양쪽 여행지 계절 기후 비교"},
    sources: ["https://www.britannica.com/place/Andes-Mountains", "https://www.britannica.com/place/Santiago-Chile", "https://www.britannica.com/place/Mendoza-Argentina"],
    images: [
      {role: "featured", placement: "featured", alt: "안데스 산맥 양쪽의 계절 기후 차이를 보여주는 산맥과 계곡 풍경", scene: "A text-free aerial view of the Andes between green western valleys and dry eastern foothills"},
      {role: "inline", placement: "after_winter_section", alt: "겨울철 안데스 산맥 서쪽과 동쪽의 강수 차이를 보여주는 산악 풍경", scene: "A text-free winter Andes mountain landscape with cloud-covered western slopes and dry eastern foothills"},
      {role: "inline", placement: "after_summer_section", alt: "여름철 산티아고와 멘도사의 여행 환경을 보여주는 안데스 산맥 풍경", scene: "A text-free summer Andes travel landscape with a city valley and dry mountain foothills"},
    ],
  };
  assert.deepEqual(validateImageDraftPlan(plan), plan);
  assert.throws(() => validateImageDraftPlan({...plan, seo: {...plan.seo, title: "다른 SEO 제목"}}), /SEO title/);
  assert.throws(() => assertPlanTitleUnused(plan, [plan.title]), /중복/);
});

test("대표 이미지와 본문 이미지 두 개가 업로드되고 Gutenberg 본문에 연결됐는지 검증한다", () => {
  const media = [
    {id: 31, source_url: "https://site.example/31.jpg", alt_text: "대표 이미지"},
    {id: 32, source_url: "https://site.example/32.jpg", alt_text: "본문 이미지 하나"},
    {id: 33, source_url: "https://site.example/33.jpg", alt_text: "본문 이미지 둘"},
  ];
  const post = {status: "draft", featured_media: 31, content: {raw: '<img class="wp-image-32"><img class="wp-image-33">'}};
  assert.deepEqual(verifyImageDraftRecord({post, media, featuredMediaId: 31, inlineMediaIds: [32, 33]}), {imageCount: 3, inlineImageCount: 2, status: "draft"});
  assert.throws(() => verifyImageDraftRecord({post: {...post, content: {raw: '<img class="wp-image-31"><img class="wp-image-32"><img class="wp-image-33">'}}, media, featuredMediaId: 31, inlineMediaIds: [32, 33]}), /중복/);
});

test("후속 초안은 제목·카테고리·요약문·핵심 키워드를 재조회로 검증한다", () => {
  const plan = {
    title: "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교",
    seo: {description: "안데스 산맥 양쪽 도시의 계절 기후를 비교합니다.", keyword: "안데스 계절 기후"},
    sources: ["https://example.test/source-a", "https://example.test/source-b", "https://example.test/source-c"],
  };
  const post = {
    status: "draft",
    title: {raw: plan.title},
    excerpt: {raw: plan.seo.description},
    categories: [4, 5],
    featured_media: 31,
    content: {raw: '<p>안데스 계절 기후 https://example.test/source-a https://example.test/source-b https://example.test/source-c</p><img class="wp-image-32"><img class="wp-image-33">'},
  };
  const media = [
    {id: 31, source_url: "https://site.example/31.jpg", alt_text: "대표 이미지"},
    {id: 32, source_url: "https://site.example/32.jpg", alt_text: "본문 이미지 하나"},
    {id: 33, source_url: "https://site.example/33.jpg", alt_text: "본문 이미지 둘"},
  ];
  assert.deepEqual(
    verifyDraftPostRequirements({post, plan, parentId: 4, childId: 5, media, featuredMediaId: 31, inlineMediaIds: [32, 33]}),
    {imageCount: 3, inlineImageCount: 2, status: "draft"},
  );
  assert.throws(() => verifyDraftPostRequirements({post: {...post, excerpt: {raw: "다른 요약"}}, plan, parentId: 4, childId: 5, media, featuredMediaId: 31, inlineMediaIds: [32, 33]}), /SEO/);
});

test("지정한 이미지 포함 글 계획은 복구 이력과 시험 이력의 제목을 피한다", () => {
  const planPath = fileURLToPath(new URL("../makeit-adsense/inputs/site-03/image-draft-followup-plan.json", import.meta.url));
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const recoveredPath = fileURLToPath(new URL("../makeit-adsense/inputs/site-03/recovered-history.json", import.meta.url));
  const trialPath = fileURLToPath(new URL("../makeit-adsense/inputs/site-03/trial-verified-history.json", import.meta.url));
  const usedTitles = [...readRecoveredHistory(recoveredPath), ...readTrialVerifiedHistory(trialPath)].map((record) => record.title);
  assert.deepEqual(validateImageDraftPlan(plan), plan);
  assert.equal(assertPlanTitleUnused(plan, usedTitles), true);
});
