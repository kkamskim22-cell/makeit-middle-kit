import assert from "node:assert/strict";
import test from "node:test";
import {runSite03ImageDraftPreflight} from "../scripts/site-03-image-draft-preflight.mjs";

const target = {
  title: "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교",
  categoryKey: "4-3",
  parentName: "세계 여행지의 계절별 기후 비교",
  childName: "바다와 지형이 만드는 계절 차이",
  locations: ["칠레 산티아고", "아르헨티나 멘도사"],
};

const recovered = Array.from({length: 68}, (_, index) => ({title: `복구 제목 ${index + 1}`}));
const trial = [{title: "지중해 지역 세계 여행지의 봄 풍경이 특별한 이유", postId: 965}];

function list(data, {total = data.length, pages = 1} = {}) {
  return Response.json(data, {headers: {"x-wp-total": String(total), "x-wp-totalpages": String(pages)}});
}

test("카테고리와 전체 글을 GET으로만 조회하고 4-3 부모 관계와 비중복을 확인한다", async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({url, options});
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get("page"));
    if (parsed.pathname.endsWith("/categories")) {
      return list([
        {id: 4, name: target.parentName, parent: 0},
        {id: 7, name: target.childName, parent: 4},
      ]);
    }
    if (page === 1) return list([{id: 1, title: {raw: "기존 제목"}, content: {raw: "<p>기존 자연환경 글</p>"}}], {total: 2, pages: 2});
    return list([{id: 2, title: {raw: "다른 기존 제목"}, content: {raw: "<p>다른 문화 글</p>"}}], {total: 2, pages: 2});
  };

  const result = await runSite03ImageDraftPreflight({
    siteBase: "https://site.example",
    authorization: "Basic test-only-secret",
    request,
    target,
    recoveredHistory: recovered,
    trialHistory: trial,
  });

  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.options.method === "GET"), true);
  assert.deepEqual(result, {
    site: 3,
    diagnosis: "완료",
    ready: true,
    categoryHttpStatuses: [200],
    postHttpStatuses: [200, 200],
    category: {key: "4-3", parentId: 4, childId: 7, parentChildVerified: true},
    wordpressPostCount: 2,
    recoveredHistoryCount: 68,
    trialHistoryCount: 1,
    duplicate: {wordpress: false, recoveredHistory: false, trialHistory: false, any: false},
    similarity: {similarTitlePostIds: [], topicBodyPostIds: [], any: false},
  });
  const postCalls = calls.filter((call) => new URL(call.url).pathname.endsWith("/posts"));
  assert.equal(postCalls.every((call) => new URL(call.url).searchParams.get("_fields") === "id,title,content"), true);
  const output = JSON.stringify(result);
  assert.equal(output.includes("test-only-secret"), false);
  assert.equal(output.includes("Authorization"), false);
  assert.equal(output.includes("기존 제목"), false);
});

test("같은 두 여행지를 다룬 기존 본문이 있으면 생성 준비를 거부한다", async () => {
  const request = async (url) => new URL(url).pathname.endsWith("/categories")
    ? list([{id: 4, name: target.parentName, parent: 0}, {id: 7, name: target.childName, parent: 4}])
    : list([{id: 10, title: {raw: "남미 도시 여행 정보"}, content: {raw: "<p>산티아고와 멘도사의 기후를 비교합니다.</p>"}}]);
  const result = await runSite03ImageDraftPreflight({
    siteBase: "https://site.example",
    authorization: "Basic test-only-secret",
    request,
    target,
    recoveredHistory: recovered,
    trialHistory: trial,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.similarity, {similarTitlePostIds: [], topicBodyPostIds: [10], any: true});
  assert.equal(JSON.stringify(result).includes("산티아고와 멘도사"), false);
});

test("WordPress 또는 이력에서 제목이 중복되면 실행 준비를 거부한다", async () => {
  const request = async (url) => new URL(url).pathname.endsWith("/categories")
    ? list([{id: 4, name: target.parentName, parent: 0}, {id: 7, name: target.childName, parent: 4}])
    : list([{id: 10, title: {raw: `  ${target.title}!  `}, content: {raw: "<p>기존 글</p>"}}]);
  const result = await runSite03ImageDraftPreflight({
    siteBase: "https://site.example",
    authorization: "Basic test-only-secret",
    request,
    target,
    recoveredHistory: [...recovered.slice(0, 67), {title: `${target.title}.`}],
    trialHistory: trial,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.duplicate, {wordpress: true, recoveredHistory: true, trialHistory: false, any: true});
});

test("검증된 새 글을 복구 이력에 추가한 뒤에도 전체 이력으로 중복을 차단한다", async () => {
  const expandedHistory = [...recovered, {title: `${target.title}.`}];
  const request = async (url) => new URL(url).pathname.endsWith("/categories")
    ? list([{id: 4, name: target.parentName, parent: 0}, {id: 7, name: target.childName, parent: 4}])
    : list([]);
  const result = await runSite03ImageDraftPreflight({
    siteBase: "https://site.example",
    authorization: "Basic test-only-secret",
    request,
    target,
    recoveredHistory: expandedHistory,
    trialHistory: trial,
  });
  assert.equal(result.recoveredHistoryCount, 69);
  assert.equal(result.ready, false);
  assert.deepEqual(result.duplicate, {wordpress: false, recoveredHistory: true, trialHistory: false, any: true});
});

test("카테고리 부모 관계가 다르거나 HTTP 오류이면 검증에 실패하고 재시도하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(
    runSite03ImageDraftPreflight({
      siteBase: "https://site.example",
      authorization: "Basic test-only-secret",
      request: async () => {
        calls += 1;
        return new Response(null, {status: 403});
      },
      target,
      recoveredHistory: recovered,
      trialHistory: trial,
    }),
    (error) => error?.safeDiagnostic?.httpStatus === 403,
  );
  assert.equal(calls, 1);

  await assert.rejects(
    runSite03ImageDraftPreflight({
      siteBase: "https://site.example",
      authorization: "Basic test-only-secret",
      request: async (url) => new URL(url).pathname.endsWith("/categories")
        ? list([{id: 4, name: target.parentName, parent: 0}, {id: 7, name: target.childName, parent: 99}])
        : list([]),
      target,
      recoveredHistory: recovered,
      trialHistory: trial,
    }),
    (error) => error?.safeDiagnostic?.reason === "category_mapping_failed",
  );
});

test("이름으로 확인한 4-3 카테고리가 승인된 ID 16과 19가 아니면 중단한다", async () => {
  await assert.rejects(
    runSite03ImageDraftPreflight({
      siteBase: "https://site.example",
      authorization: "Basic test-only-secret",
      request: async (url) => new URL(url).pathname.endsWith("/categories")
        ? list([{id: 20, name: target.parentName, parent: 0}, {id: 21, name: target.childName, parent: 20}])
        : list([]),
      target,
      recoveredHistory: recovered,
      trialHistory: trial,
      expectedCategoryIds: {parentId: 16, childId: 19},
    }),
    (error) => error?.safeDiagnostic?.reason === "category_id_mismatch",
  );
});
