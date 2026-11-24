import assert from "node:assert/strict";
import test from "node:test";
import {
  ARTICLE_MINIMUM_CHARACTER_COUNT,
  countArticleBodyCharacters,
  countArticleCharacters,
  parseArticleResponseData,
  parseStructuredArticleResponseData,
  validateGutenbergArticle,
} from "../scripts/lib/site-03-image-draft-article.mjs";
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
    matchesDiagnostic({stage: "article_generation", errorType: "article_gutenberg_missing", characterCount: 3114, hasGutenbergBlocks: false, hasH1: false}),
  );
});

test("h1 포함과 Gutenberg 블록 누락을 안전한 진단으로 구분한다", () => {
  const body = "가".repeat(1400);
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: `<h1>제목</h1><p>${body}</p>`, output: []}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_h1_forbidden", characterCount: 1402, hasGutenbergBlocks: false, hasH1: true}),
  );
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: `<p>${body}</p>`, output: []}, requireTravelArticleStructure: true}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_gutenberg_missing", characterCount: 1400, hasGutenbergBlocks: false, hasH1: false}),
  );
});

test("표준 HTML은 변환하지 않고 짝이 맞지 않거나 루트가 바뀐 Gutenberg도 차단한다", () => {
  const body = "가".repeat(1400);
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: `<h2>소제목</h2><p>${body}</p>`, output: []}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_gutenberg_missing", characterCount: 1403, hasGutenbergBlocks: false, hasH1: false}),
  );
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: `<!-- wp:paragraph --><p>${body}</p>`, output: []}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_gutenberg_structure", characterCount: 1400, requiredBlocks: []}),
  );
  assert.throws(
    () => parseArticleResponseData({httpStatus: 200, data: {status: "completed", output_text: `<!-- wp:paragraph --><h2>${body}</h2><!-- /wp:paragraph -->`, output: []}}),
    matchesDiagnostic({stage: "article_generation", errorType: "article_gutenberg_structure", characterCount: 1400, requiredBlocks: []}),
  );
});

const sources = ["https://example.test/a", "https://example.test/b", "https://example.test/c"];

function structuredDocument() {
  return {
    sections: Array.from({length: 5}, (_, index) => ({
      heading: `계절 비교 ${index + 1}`,
      paragraphs: [`${"가".repeat(140)} 산티아고`, `${"나".repeat(140)} 멘도사`],
    })),
    table: {
      headers: ["항목", "산티아고", "멘도사"],
      rows: [["여름", "건조", "덥고 건조"], ["겨울", "비가 잦음", "건조하고 서늘함"]],
    },
    checklist: ["계절을 확인한다", "자외선에 대비한다", "산악 도로 상황을 확인한다"],
    sources: [...sources],
  };
}

test("엄격한 JSON 원고를 현재 Gutenberg 소제목·문단·표·목록 블록으로 생성한다", () => {
  const html = parseStructuredArticleResponseData({
    httpStatus: 200,
    data: {status: "completed", output_text: JSON.stringify(structuredDocument()), output: []},
    expectedSources: sources,
  });
  assert.ok(countArticleCharacters(html) >= 1300);
  assert.match(html, /<!-- wp:heading -->\s*<h2 class="wp-block-heading">/);
  assert.match(html, /<!-- wp:paragraph -->\s*<p>/);
  assert.match(html, /<!-- wp:table \{"hasFixedLayout":true\} -->/);
  assert.match(html, /<!-- wp:list -->[\s\S]*<!-- wp:list-item -->/);
  assert.deepEqual(validateGutenbergArticle(html, {requireTravelArticleStructure: true}), {
    headingCount: 7,
    paragraphCount: 11,
    tableCount: 1,
    listCount: 1,
    imageCount: 0,
  });
});

test("JSON 원고의 HTML·추가 필드·잘못된 출처는 안전하게 거부한다", () => {
  for (const mutate of [
    (document) => { document.sections[0].heading = '<img src=x onerror="alert(1)">'; },
    (document) => { document.unexpected = "field"; },
    (document) => { document.sources[0] = "https://attacker.example"; },
  ]) {
    const document = structuredDocument();
    mutate(document);
    assert.throws(
      () => parseStructuredArticleResponseData({
        httpStatus: 200,
        data: {status: "completed", output_text: JSON.stringify(document), output: []},
        expectedSources: sources,
      }),
      matchesDiagnostic({stage: "article_generation", errorType: "article_structure_invalid"}),
    );
  }
});

test("실제 JSON 진입점도 h1과 Gutenberg 누락 HTML을 구분해 진단한다", () => {
  assert.throws(
    () => parseStructuredArticleResponseData({
      data: {status: "completed", output_text: `<h1>제목</h1><p>${"가".repeat(1400)}</p>`, output: []},
      expectedSources: sources,
    }),
    matchesDiagnostic({stage: "article_generation", errorType: "article_h1_forbidden", characterCount: 1402, hasGutenbergBlocks: false, hasH1: true}),
  );
  assert.throws(
    () => parseStructuredArticleResponseData({
      data: {status: "completed", output_text: `<h2>제목</h2><p>${"가".repeat(1400)}</p>`, output: []},
      expectedSources: sources,
    }),
    matchesDiagnostic({stage: "article_generation", errorType: "article_gutenberg_missing", characterCount: 1402, hasGutenbergBlocks: false, hasH1: false}),
  );
});

test("저장 후 원고 글자 수는 이미지 캡션과 보이지 않는 U+2060을 제외한다", () => {
  const html = `<!-- wp:paragraph -->\n<p>${"가".repeat(1299)}${"\u2060".repeat(100)}</p>\n<!-- /wp:paragraph -->\n\n` +
    `<!-- wp:image {"id":32,"sizeSlug":"large","linkDestination":"none"} -->\n<figure class="wp-block-image size-large"><img src="https://site.example/32.jpg" alt="설명" class="wp-image-32"><figcaption>${"캡션".repeat(100)}</figcaption></figure>\n<!-- /wp:image -->`;
  assert.equal(countArticleBodyCharacters(html), 1299);
});
