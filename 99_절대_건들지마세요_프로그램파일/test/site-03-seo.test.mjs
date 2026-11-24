import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {
  applyFocusKeywordToFirstParagraph,
  buildSite03DraftPayload,
  estimateVisibleWordCount,
  saveRankMathMetadata,
  validateSite03Seo,
} from "../scripts/lib/site-03-seo.mjs";

const keyword = "안데스 산맥 양쪽 여행지 계절 기후 비교";
const seo = {
  keyword,
  title: `${keyword} | 산티아고와 멘도사`,
  description: `${keyword}를 통해 산티아고와 멘도사의 강수와 여행 환경 차이를 알아봅니다.`,
  slug: "안데스-산맥-양쪽-여행지-계절-기후-비교",
};

const article = [
  '<!-- wp:heading {"level":2} -->',
  '<h2 class="wp-block-heading">두 도시의 위치</h2>',
  '<!-- /wp:heading -->',
  '<!-- wp:paragraph -->',
  '<p>산티아고와 멘도사는 안데스 산맥을 사이에 두고 있습니다.</p>',
  '<!-- /wp:paragraph -->',
  '<!-- wp:paragraph -->',
  `<p>${keyword}는 여행 시기를 정할 때 유용한 관점입니다.</p>`,
  '<!-- /wp:paragraph -->',
].join("\n");

test("사이트 3 SEO 제목·설명·slug에 동일한 포커스 키워드를 요구한다", () => {
  assert.deepEqual(validateSite03Seo(seo), {
    focusKeyword: keyword,
    title: seo.title,
    description: seo.description,
    slug: seo.slug,
  });
  assert.throws(() => validateSite03Seo({...seo, title: "다른 SEO 제목"}), /SEO 제목/);
  assert.throws(() => validateSite03Seo({...seo, description: "다른 설명"}), /메타 설명/);
  assert.throws(() => validateSite03Seo({...seo, slug: "different-slug"}), /URL/);
});

test("포커스 키워드를 첫 문단에 한 번 보정하고 Gutenberg 구조를 보존한다", () => {
  const updated = applyFocusKeywordToFirstParagraph(article, keyword);
  const firstParagraph = updated.match(/<!-- wp:paragraph -->\s*<p>([\s\S]*?)<\/p>\s*<!-- \/wp:paragraph -->/u)?.[1] || "";
  assert.match(firstParagraph, new RegExp(keyword));
  assert.equal((updated.match(new RegExp(keyword, "gu")) || []).length, 2);
  assert.match(updated, /<!-- wp:heading/);
  assert.equal(applyFocusKeywordToFirstParagraph(updated, keyword), updated);
});

test("600단어는 권장값으로 계산만 하고 저장 차단 조건으로 사용하지 않는다", () => {
  assert.ok(estimateVisibleWordCount(article) < 600);
  assert.doesNotThrow(() => buildSite03DraftPayload({
    plan: {title: "제목", seo},
    content: applyFocusKeywordToFirstParagraph(article, keyword),
    parentId: 16,
    childId: 19,
    featuredMediaId: 31,
  }));
});

test("초안 payload는 SEO slug와 기존 draft·카테고리·이미지 조건을 함께 유지한다", () => {
  const content = applyFocusKeywordToFirstParagraph(article, keyword);
  assert.deepEqual(buildSite03DraftPayload({
    plan: {title: "제목", seo}, content, parentId: 16, childId: 19, featuredMediaId: 31,
  }), {
    title: "제목",
    content,
    status: "draft",
    slug: seo.slug,
    categories: [16, 19],
    featured_media: 31,
    excerpt: seo.description,
  });
});

test("Rank Math 전용 경로에 SEO 메타를 정확히 한 번 저장하고 리디렉션을 차단한다", async () => {
  const calls = [];
  const result = await saveRankMathMetadata({
    base: "https://site.example",
    headers: {Authorization: "Basic masked"},
    postId: 969,
    seo,
    request: async (url, options) => {
      calls.push({url, options});
      return new Response(JSON.stringify({success: true}), {status: 200});
    },
  });
  assert.deepEqual(result, {saved: true, httpStatus: 200, focusKeyword: keyword});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://site.example/wp-json/rankmath/v1/updateMeta");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    objectID: 969,
    objectType: "post",
    meta: {
      rank_math_focus_keyword: keyword,
      rank_math_title: seo.title,
      rank_math_description: seo.description,
    },
  });
});

test("Rank Math 저장 실패는 응답 본문을 노출하거나 재시도하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(() => saveRankMathMetadata({
    base: "https://site.example",
    headers: {},
    postId: 969,
    seo,
    request: async () => {
      calls += 1;
      return new Response("sensitive plugin error", {status: 403});
    },
  }), (error) => error?.message === "Rank Math 메타데이터 저장 실패" && error?.httpStatus === 403);
  assert.equal(calls, 1);
});

test("사이트 3 계획과 생성 경로가 SEO 자동 적용 기능에 연결된다", () => {
  const planPath = fileURLToPath(new URL("../makeit-adsense/inputs/site-03/image-draft-followup-plan.json", import.meta.url));
  const scriptPath = fileURLToPath(new URL("../scripts/site-03-image-draft-followup.mjs", import.meta.url));
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const script = readFileSync(scriptPath, "utf8");
  assert.equal(validateSite03Seo(plan.seo).focusKeyword, keyword);
  assert.equal(plan.articleRequirements.recommendedWordCount, 600);
  assert.match(script, /applyFocusKeywordToFirstParagraph\(article, plan\.seo\.keyword\)/);
  assert.match(script, /buildSite03DraftPayload\(/);
  assert.match(script, /saveRankMathMetadata\(/);
  assert.match(script, /rankMathSaved: rankMath\.saved/);
  assert.match(script, /articleWordCount/);
  assert.match(script, /_fields=id,title,content,excerpt,slug,status,categories,featured_media/);
});
