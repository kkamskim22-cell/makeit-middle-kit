import assert from "node:assert/strict";
import test from "node:test";
import {ARTICLE_MINIMUM_CHARACTER_COUNT, parseArticleResponseData} from "../scripts/lib/site-03-image-draft-article.mjs";
import {safeTrialDiagnostic} from "../scripts/lib/site-03-trial-diagnostics.mjs";

const validHtml = `<!-- wp:paragraph --><p>${"가".repeat(1800)}</p><!-- /wp:paragraph -->`;

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

test("사이트 3 최소 본문 기준은 공백 제외 1,300자이다", () => {
  assert.equal(ARTICLE_MINIMUM_CHARACTER_COUNT, 1300);
  const html = `<!-- wp:paragraph --><p>${"가 ".repeat(1300)}</p><!-- /wp:paragraph -->`;
  assert.equal(parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: html, output: []}}), html);
});

test("공백 제외 실제 본문이 1,300자 미만이면 article_too_short로 중단한다", () => {
  const html = `<!-- wp:paragraph --><p>${"가".repeat(1299)}</p><!-- /wp:paragraph -->`;
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: html, output: []}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_too_short", characterCount: 1299, minimumCharacterCount: 1300}),
  );
});

test("실제 본문이 2,500자를 초과해도 완성된 Gutenberg HTML이면 허용한다", () => {
  const html = `<!-- wp:paragraph --><p>${"가".repeat(2501)}</p><!-- /wp:paragraph -->`;
  assert.equal(parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: html, output: []}}), html);
});

test("HTML 태그와 공백 엔티티 및 보이지 않는 공백은 글자 수를 늘리지 않는다", () => {
  const html = `<!-- wp:paragraph --><p>${"가".repeat(1298)}${"\u200b".repeat(20)} &nbsp; &amp;</p><!-- /wp:paragraph -->`;
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: html, output: []}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_too_short", characterCount: 1299, minimumCharacterCount: 1300}),
  );
});

test("숫자형 공백 엔티티도 실제 본문 글자 수를 늘리지 않는다", () => {
  for (const suffix of [
    "&#32;&#x20;&#9;&#xA;",
    "&#32&#x20",
    "&Tab;&NewLine;&MediumSpace;",
    '<span title="a>b"></span>',
  ]) {
    const html = `<!-- wp:paragraph --><p>${"가".repeat(1299)}${suffix}</p><!-- /wp:paragraph -->`;
    assert.throws(
      () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: html, output: []}}),
      matchesDiagnostic({stage: "article_generation", errorType: "article_too_short", characterCount: 1299, minimumCharacterCount: 1300}),
    );
  }
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
