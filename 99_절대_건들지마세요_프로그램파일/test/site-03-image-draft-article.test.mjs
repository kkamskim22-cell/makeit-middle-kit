import assert from "node:assert/strict";
import test from "node:test";
import {parseArticleResponseData} from "../scripts/lib/site-03-image-draft-article.mjs";
import {safeTrialDiagnostic} from "../scripts/lib/site-03-trial-diagnostics.mjs";

const validHtml = `<!-- wp:paragraph --><p>${"가".repeat(3100)}</p><!-- /wp:paragraph -->`;

function diagnostic(error) {
  return safeTrialDiagnostic(error, "article_generation");
}

function matchesDiagnostic(expected) {
  return (error) => {
    assert.deepEqual(diagnostic(error), expected);
    return true;
  };
}

test("Responses API output 배열의 output_text 본문을 추출한다", () => {
  const html = parseArticleResponseData({
    httpStatus: 200,
    data: {
      status: "completed",
      output: [{type: "message", content: [{type: "output_text", text: validHtml}]}],
    },
  });
  assert.equal(html, validHtml);
});

test("최상위 output_text 본문도 기존처럼 허용한다", () => {
  assert.equal(parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: validHtml, output: []}}), validHtml);
});

test("완료 응답에 실제 본문이 없으면 article_empty로 구분한다", () => {
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output: [{type: "message", content: []}]}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_empty", httpStatus: 200}),
  );
});

test("불완전 응답은 중단 사유와 함께 article_incomplete로 구분한다", () => {
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "incomplete", incomplete_details: {reason: "max_output_tokens"}, output: []}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_incomplete", finishReason: "max_output_tokens"}),
  );
});

test("output 컨테이너 형식이 잘못되면 article_response로 구분한다", () => {
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output: {unexpected: true}}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_response", httpStatus: 200}),
  );
});

test("JSON 또는 일반 텍스트 출력은 Gutenberg HTML 오류로 구분한다", () => {
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output: [{content: [{type: "output_text", text: JSON.stringify({content: "가".repeat(3100)})}]}]}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_html_invalid", htmlRule: "gutenberg_or_h1", characterCount: 3114}),
  );
});
