#!/usr/bin/env node

import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {browserHeaders} from "./lib/wp.mjs";
import {requireLicense} from "./lib/env.mjs";
import {readRecoveredHistory, readTrialVerifiedHistory} from "./lib/site-03-recovered-history.mjs";
import {
  assessPlanSimilarity,
  assertArticleContentDistinct,
  assertPlanTitleUnused,
  matchingTitlePostIds,
  validateImageDraftPlan,
  verifyDraftPostRequirements,
} from "./lib/site-03-image-draft-plan.mjs";
import {
  ARTICLE_MINIMUM_CHARACTER_COUNT,
  countArticleBodyCharacters,
  countArticleCharacters,
  parseStructuredArticleResponseData,
  splitTopLevelGutenbergBlocks,
  validateGutenbergArticle,
} from "./lib/site-03-image-draft-article.mjs";
import {createMediaIdRecorder} from "./lib/site-03-image-draft-safety.mjs";
import {
  applyFocusKeywordToFirstParagraph,
  buildSite03DraftPayload,
  estimateVisibleWordCount,
  saveRankMathMetadata,
} from "./lib/site-03-seo.mjs";
import {attachTrialDiagnostic, safeOpenAiCode, safeTrialDiagnostic} from "./lib/site-03-trial-diagnostics.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const programRoot = dirname(scriptDir);
const planPath = join(programRoot, "makeit-adsense", "inputs", "site-03", "image-draft-followup-plan.json");
const recoveredPath = join(programRoot, "makeit-adsense", "inputs", "site-03", "recovered-history.json");
const trialHistoryPath = join(programRoot, "makeit-adsense", "inputs", "site-03", "trial-verified-history.json");
const ORIGINAL_WORKFLOW_REF = "kkamskim22-cell/makeit-middle-kit/.github/workflows/site-03-image-draft-followup.yml@refs/heads/main";

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

export function validateRequiredCategoryIds({parentId, childId, expectedCategoryIds} = {}) {
  if (!positiveInteger(parentId) || !positiveInteger(childId)) {
    throw new Error("확인된 상위·세부 카테고리 ID가 필요합니다.");
  }
  if (expectedCategoryIds && (parentId !== expectedCategoryIds.parentId || childId !== expectedCategoryIds.childId)) {
    throw new Error("사전 확인한 4-3 카테고리 ID와 일치하지 않습니다.");
  }
  return {parentId, childId};
}

export function postDraftOnce({url, headers, payload, request = fetch}) {
  return request(url, {
    method: "POST",
    redirect: "error",
    headers: {...headers, "Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
}

function siteUrl(value) {
  const raw = String(value || "").trim().replace(/^['"]+|['"]+$/g, "");
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
}

function authorization(user, password) {
  return `Basic ${Buffer.from(`${String(user || "").trim()}:${String(password || "").trim()}`).toString("base64")}`;
}

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function imageBlock(media) {
  return [
    `<!-- wp:image {"id":${media.id},"sizeSlug":"large","linkDestination":"none"} -->`,
    `<figure class="wp-block-image size-large"><img src="${escapeHtml(media.sourceUrl)}" alt="${escapeHtml(media.altText)}" class="wp-image-${media.id}"><figcaption>${escapeHtml(media.caption)}</figcaption></figure>`,
    "<!-- /wp:image -->",
  ].join("\n");
}

export function insertInlineImages(html, images) {
  const blocks = splitTopLevelGutenbergBlocks(html).map((block) => block.html);
  if (blocks.length < 3) throw new Error("본문 블록 수가 이미지 삽입에 충분하지 않습니다.");
  blocks.splice(Math.min(4, blocks.length), 0, imageBlock(images[0]));
  blocks.splice(Math.min(10, blocks.length), 0, imageBlock(images[1]));
  const content = blocks.join("\n\n");
  validateGutenbergArticle(content, {requireTravelArticleStructure: true, expectedImages: images.map((image) => ({id: image.id, sourceUrl: image.sourceUrl}))});
  return content;
}

async function jsonResponse(response, errorType) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw attachTrialDiagnostic(new Error("응답 JSON 해석 실패"), errorType, {httpStatus: response.status});
  }
}

export async function getAllPosts({base, headers, request = fetch}) {
  const posts = [];
  let expectedTotal = null;
  let expectedPages = null;
  for (let page = 1; page <= 30; page += 1) {
    const response = await request(`${base}/wp-json/wp/v2/posts?context=edit&status=draft,pending,future,publish,private,trash&per_page=100&page=${page}&orderby=id&order=asc&_fields=id,title,content`, {method: "GET", headers});
    if (response.status !== 200) throw attachTrialDiagnostic(new Error("글 목록 조회 실패"), "article_response", {httpStatus: response.status});
    const data = await jsonResponse(response, "article_response");
    if (!Array.isArray(data)) throw attachTrialDiagnostic(new Error("글 목록 형식 오류"), "article_response", {httpStatus: response.status});
    const totalHeader = response.headers.get("x-wp-total");
    const pagesHeader = response.headers.get("x-wp-totalpages");
    if (!/^\d+$/.test(totalHeader || "") || !/^\d+$/.test(pagesHeader || "")) throw new Error("글 목록 페이지 정보 오류");
    const total = Number(totalHeader);
    const pages = Number(response.headers.get("x-wp-totalpages"));
    expectedTotal ??= total;
    expectedPages ??= pages;
    if (total !== expectedTotal || pages !== expectedPages || pages < 1 || pages > 30 || page > pages) throw new Error("글 목록 페이지 정보 오류");
    posts.push(...data);
    if (page === pages) break;
  }
  if (posts.length !== expectedTotal || new Set(posts.map((post) => post?.id)).size !== posts.length ||
      posts.some((post) => !Number.isSafeInteger(post?.id) || post.id <= 0)) {
    throw new Error("전체 글 목록을 완전하게 확인하지 못했습니다.");
  }
  return posts;
}

async function getAllCategories({base, headers}) {
  const categories = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetch(`${base}/wp-json/wp/v2/categories?per_page=100&page=${page}&hide_empty=false&orderby=id&order=asc&_fields=id,name,parent`, {method: "GET", headers});
    if (response.status !== 200) throw attachTrialDiagnostic(new Error("카테고리 조회 실패"), "article_response", {httpStatus: response.status});
    const data = await jsonResponse(response, "article_response");
    if (!Array.isArray(data)) throw new Error("카테고리 목록 형식 오류");
    categories.push(...data);
    const pages = Number(response.headers.get("x-wp-totalpages"));
    if (!Number.isInteger(pages) || pages < 1 || pages > 30) throw new Error("카테고리 목록 페이지 정보 오류");
    if (page === pages) return categories;
  }
  throw new Error("카테고리 목록이 너무 많아 안전하게 확인하지 못했습니다.");
}

async function createArticle({apiKey, plan}) {
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        max_output_tokens: 12000,
        input: [{role: "user", content: [
          "Write a Korean informational travel-climate article as the requested JSON object only.",
          `Title: ${plan.title}`,
          "Compare Santiago, Chile and Mendoza, Argentina across seasons, explaining the Andes rain-shadow context carefully.",
          "Fact-check these points: Southern Hemisphere seasons are reversed from Korea; Santiago has a Mediterranean pattern with dry summers and most rain in the cool season; Mendoza is arid to semi-arid on the eastern side of the Andes, with stronger continental and day-night temperature ranges and relatively more warm-season convective rain. Mention winter pass or mountain-road disruption and hot-season sun/dehydration only as practical possibilities, not guarantees.",
          `Use these exact source URL strings in the sources array, in this order: ${plan.sources.join(" ")}`,
          "The combined Korean text should contain 1,600-2,000 visible characters excluding whitespace, and must never be shorter than 1,300 characters.",
          "A 600-word article is recommended when the subject supports it, but do not pad or repeat ideas and do not treat 600 words as a hard requirement.",
          "Use exactly 5 sections with 2-3 substantive paragraphs each, one 3-column comparison table with 2-8 rows, and a 3-6 item practical checklist. Do not repeat ideas or add filler.",
          "Every JSON string must be plain text without HTML, Markdown, scripts, or unsupported claims.",
          `SEO keyword: ${plan.seo.keyword}`,
        ].join("\n")}],
        text: {format: {
          type: "json_schema",
          name: "site_03_travel_article",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["sections", "table", "checklist", "sources"],
            properties: {
              sections: {type: "array", minItems: 5, maxItems: 5, items: {type: "object", additionalProperties: false, required: ["heading", "paragraphs"], properties: {
                heading: {type: "string"}, paragraphs: {type: "array", minItems: 2, maxItems: 3, items: {type: "string"}},
              }}},
              table: {type: "object", additionalProperties: false, required: ["headers", "rows"], properties: {
                headers: {type: "array", minItems: 3, maxItems: 3, items: {type: "string"}},
                rows: {type: "array", minItems: 2, maxItems: 8, items: {type: "array", minItems: 3, maxItems: 3, items: {type: "string"}}},
              }},
              checklist: {type: "array", minItems: 3, maxItems: 6, items: {type: "string"}},
              sources: {type: "array", minItems: 3, maxItems: 3, items: {type: "string"}},
            },
          },
        }},
      }),
    });
  } catch (error) {
    throw attachTrialDiagnostic(error, "article_api");
  }
  const data = await jsonResponse(response, "article_response");
  if (!response.ok) throw attachTrialDiagnostic(new Error("본문 API 실패"), "article_api", {httpStatus: response.status, openAiCode: safeOpenAiCode(data)});
  const article = parseStructuredArticleResponseData({
    data,
    httpStatus: response.status,
    minimumCharacterCount: ARTICLE_MINIMUM_CHARACTER_COUNT,
    expectedSources: plan.sources,
  });
  return applyFocusKeywordToFirstParagraph(article, plan.seo.keyword);
}

async function createAndUploadImage({apiKey, base, headers, image, title, onUploaded}) {
  let imageResponse;
  try {
    imageResponse = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
      body: JSON.stringify({model: "gpt-image-1-mini", prompt: `Create a text-free realistic editorial travel image. Scene: ${image.scene}. No words, letters, signs, logos, watermarks, or people faces.`, n: 1, size: "1536x1024", quality: "low", output_format: "jpeg"}),
    });
  } catch (error) {
    throw attachTrialDiagnostic(error, "article_api");
  }
  const generated = await jsonResponse(imageResponse, "article_response");
  if (!imageResponse.ok || !generated.data?.[0]?.b64_json) throw attachTrialDiagnostic(new Error("이미지 생성 실패"), "article_api", {httpStatus: imageResponse.status, openAiCode: safeOpenAiCode(generated)});
  const upload = await fetch(`${base}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {...headers, "Content-Type": "image/jpeg", "Content-Disposition": `attachment; filename="site-03-${image.role}.jpg"`},
    body: Buffer.from(generated.data[0].b64_json, "base64"),
  });
  const media = await jsonResponse(upload, "article_response");
  if (!upload.ok || !Number.isSafeInteger(media.id)) throw attachTrialDiagnostic(new Error("이미지 업로드 실패"), "article_response", {httpStatus: upload.status});
  onUploaded?.({role: image.role, id: media.id});
  const update = await fetch(`${base}/wp-json/wp/v2/media/${media.id}`, {
    method: "POST",
    headers: {...headers, "Content-Type": "application/json"},
    body: JSON.stringify({title: `${title} 이미지`, alt_text: image.alt, caption: image.alt, description: image.alt}),
  });
  const updated = await jsonResponse(update, "article_response");
  if (!update.ok || updated.alt_text !== image.alt || !updated.source_url) throw attachTrialDiagnostic(new Error("이미지 검증 실패"), "article_response", {httpStatus: update.status});
  const verification = await fetch(`${base}/wp-json/wp/v2/media/${updated.id}?context=edit&_fields=id,source_url,alt_text`, {method: "GET", headers});
  const verified = await jsonResponse(verification, "article_response");
  if (!verification.ok || verified.id !== updated.id || verified.alt_text !== image.alt || !verified.source_url) {
    throw attachTrialDiagnostic(new Error("이미지 재조회 검증 실패"), "article_response", {httpStatus: verification.status});
  }
  return {id: verified.id, sourceUrl: verified.source_url, altText: verified.alt_text, caption: image.alt};
}

export async function runImageDraftFollowup({expectedWorkflowRef = ORIGINAL_WORKFLOW_REF, expectedCategoryIds} = {}) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_WORKFLOW_REF !== expectedWorkflowRef || process.env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error("전용 후속 워크플로의 최초 시도에서만 실행할 수 있습니다.");
  }
  const env = requireLicense({scriptLabel: "사이트 3 이미지 포함 임시글"});
  const plan = validateImageDraftPlan(JSON.parse(readFileSync(planPath, "utf8")));
  const base = siteUrl(env.ADSENSE_SITE_03_URL);
  const headers = {...browserHeaders(base), Authorization: authorization(env.ADSENSE_SITE_03_USER, env.ADSENSE_SITE_03_APP_PASSWORD), Accept: "application/json"};
  const categoryIds = validateRequiredCategoryIds({
    parentId: positiveInteger(argument("parent-category-id")),
    childId: positiveInteger(argument("child-category-id")),
    expectedCategoryIds,
  });
  const {parentId, childId} = categoryIds;
  if (!base) throw new Error("사이트 주소가 필요합니다.");
  const mediaRecorder = createMediaIdRecorder();
  const recordUploadedMedia = (record) => {
    const summary = mediaRecorder.record(record);
    const mediaRole = record.role === "featured" ? "featured" : `inline_${summary.inlineMediaIds.length}`;
    console.log(JSON.stringify({site: 3, event: "media_uploaded", mediaRole, mediaId: record.id, uploadedMediaCount: summary.uploadedMediaCount}));
  };
  let stage = "preflight";
  try {
    const categories = await getAllCategories({base, headers});
    const posts = await getAllPosts({base, headers});
    const history = [...readRecoveredHistory(recoveredPath), ...readTrialVerifiedHistory(trialHistoryPath)];
    assertPlanTitleUnused(plan, [...posts.map((post) => post?.title?.raw), ...history.map((entry) => entry.title)]);
    if (assessPlanSimilarity(plan, posts).any) throw new Error("기존 글과 제목 또는 핵심 주제가 유사하여 생성을 중단합니다.");
    const child = categories.find((category) => category.id === childId && category.parent === parentId);
    const parent = categories.find((category) => category.id === parentId && category.parent === 0);
    if (!parent || !child) throw new Error("기존 카테고리 4-3의 상위·세부 ID 관계를 확인하지 못했습니다.");
    stage = "article_generation";
    const article = await createArticle({apiKey: env.OPENAI_API_KEY, plan});
    const articleCharacterCount = countArticleCharacters(article);
    const articleWordCount = estimateVisibleWordCount(article);
    stage = "article_similarity_validation";
    assertArticleContentDistinct(article, posts);
    stage = "wordpress_preupload_duplicate_recheck";
    const preuploadPosts = await getAllPosts({base, headers});
    assertPlanTitleUnused(plan, [...preuploadPosts.map((post) => post?.title?.raw), ...history.map((entry) => entry.title)]);
    if (assessPlanSimilarity(plan, preuploadPosts).any) throw new Error("이미지 업로드 전 기존 글과 제목 또는 핵심 주제가 유사하여 중단합니다.");
    assertArticleContentDistinct(article, preuploadPosts);
    stage = "image_generation";
    const featuredPlan = plan.images.find((image) => image.role === "featured");
    const inlinePlans = plan.images.filter((image) => image.role === "inline");
    const featured = await createAndUploadImage({apiKey: env.OPENAI_API_KEY, base, headers, image: featuredPlan, title: plan.title, onUploaded: recordUploadedMedia});
    const inline = [];
    for (const image of inlinePlans) inline.push(await createAndUploadImage({apiKey: env.OPENAI_API_KEY, base, headers, image, title: plan.title, onUploaded: recordUploadedMedia}));
    const mediaSummary = mediaRecorder.assertComplete();
    const content = insertInlineImages(article, inline);
    validateGutenbergArticle(content, {requireTravelArticleStructure: true, expectedImages: inline.map((item) => ({id: item.id, sourceUrl: item.sourceUrl}))});
    stage = "wordpress_duplicate_recheck";
    const currentPosts = await getAllPosts({base, headers});
    assertPlanTitleUnused(plan, [...currentPosts.map((post) => post?.title?.raw), ...history.map((entry) => entry.title)]);
    if (assessPlanSimilarity(plan, currentPosts).any) throw new Error("생성 직전 기존 글과 제목 또는 핵심 주제가 유사하여 중단합니다.");
    assertArticleContentDistinct(article, currentPosts);
    stage = "wordpress_draft_create";
    const createdResponse = await postDraftOnce({
      url: `${base}/wp-json/wp/v2/posts?context=edit`,
      headers,
      payload: buildSite03DraftPayload({plan, content, parentId, childId, featuredMediaId: featured.id}),
    });
    const created = await jsonResponse(createdResponse, "article_response");
    if (!createdResponse.ok || !Number.isSafeInteger(created.id)) throw attachTrialDiagnostic(new Error("임시글 생성 실패"), "article_response", {httpStatus: createdResponse.status});
    stage = "rank_math_metadata_save";
    const rankMath = await saveRankMathMetadata({base, headers, postId: created.id, seo: plan.seo});
    stage = "wordpress_draft_verify";
    const postResponse = await fetch(`${base}/wp-json/wp/v2/posts/${created.id}?context=edit&_fields=id,title,content,excerpt,slug,status,categories,featured_media`, {method: "GET", headers});
    const post = await jsonResponse(postResponse, "article_response");
    if (!postResponse.ok) throw attachTrialDiagnostic(new Error("임시글 재조회 실패"), "article_response", {httpStatus: postResponse.status});
    const verify = verifyDraftPostRequirements({post, plan, parentId, childId, media: [{id: featured.id, source_url: featured.sourceUrl, alt_text: featured.altText}, ...inline.map((item) => ({id: item.id, source_url: item.sourceUrl, alt_text: item.altText}))], featuredMediaId: featured.id, inlineMediaIds: inline.map((item) => item.id)});
    validateGutenbergArticle(post.content.raw, {requireTravelArticleStructure: true, expectedImages: inline.map((item) => ({id: item.id, sourceUrl: item.sourceUrl}))});
    if (countArticleBodyCharacters(post.content.raw) < ARTICLE_MINIMUM_CHARACTER_COUNT) throw new Error("저장된 본문 분량 검증에 실패했습니다.");
    stage = "wordpress_duplicate_verify";
    const verifiedPosts = await getAllPosts({base, headers});
    const matchingIds = matchingTitlePostIds(plan.title, verifiedPosts);
    if (matchingIds.length !== 1 || matchingIds[0] !== post.id) throw new Error("생성 후 제목 중복 검증에 실패했습니다.");
    console.log(JSON.stringify({site: 3, status: "draft", postId: post.id, articleCharacterCount, articleWordCount, rankMathSaved: rankMath.saved, imageCount: verify.imageCount, inlineImageCount: verify.inlineImageCount, duplicate: false, duplicateTitleCount: matchingIds.length, contentSimilarity: "passed", ...mediaSummary}));
  } catch (error) {
    console.error(JSON.stringify({site: 3, ...safeTrialDiagnostic(error, stage), ...mediaRecorder.summary()}));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runImageDraftFollowup();
}
