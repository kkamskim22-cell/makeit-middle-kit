import test from "node:test";
import assert from "node:assert/strict";
import {compareTitles, safePostSummary, shouldRecommendResume} from "../scripts/site-03-readonly-diagnostic.mjs";

test("제목 대조는 정규화된 같은 제목을 중복 위험으로 표시한다", () => {
  const result = compareTitles(["  같은   제목  "], ["같은 제목", "새 제목"]);
  assert.deepEqual(result, {
    status: "확정",
    risk: "감지됨",
    totalTitles: 1,
    matchingTitles: 1,
    unwrittenTitles: 0,
  });
});

test("글 요약에는 제목 원문과 인증 정보가 포함되지 않는다", () => {
  const result = safePostSummary(874, 200, {id: 874, title: {raw: "비공개 제목"}, status: "draft"});
  assert.deepEqual(result, {id: 874, exists: true, postStatus: "draft", httpStatus: 200});
  assert.equal(JSON.stringify(result).includes("비공개 제목"), false);
});

test("기존 글 하나라도 없으면 자동화 재개를 권장하지 않는다", () => {
  assert.equal(shouldRecommendResume(false, 1, [{exists: true}, {exists: false}, {exists: true}]), false);
});

test("미작성 제목이 없으면 자동화 재개를 권장하지 않는다", () => {
  assert.equal(shouldRecommendResume(false, 0, [{exists: true}, {exists: true}, {exists: true}]), false);
});
