#!/usr/bin/env node

import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {browserHeaders} from "./lib/wp.mjs";
import {requireLicense} from "./lib/env.mjs";
import {readRecoveredHistory, readTrialVerifiedHistory} from "./lib/site-03-recovered-history.mjs";
import {assertPlanTitleUnused, validateImageDraftPlan, verifyDraftPostRequirements} from "./lib/site-03-image-draft-plan.mjs";
import {attachTrialDiagnostic, safeOpenAiCode, safeTrialDiagnostic} from "./lib/site-03-trial-diagnostics.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const programRoot = dirname(scriptDir);
const planPath = join(programRoot, "makeit-adsense", "inputs", "site-03", "image-draft-followup-plan.json");
const recoveredPath = join(programRoot, "makeit-adsense", "inputs", "site-03", "recovered-history.json");
const trialHistoryPath = join(programRoot, "makeit-adsense", "inputs", "site-03", "trial-verified-history.json");

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : "";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
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

function insertInlineImages(html, images) {
  const blocks = String(html || "").trim().split(/\n{2,}/).filter(Boolean);
  if (blocks.length < 3) throw new Error("본문 블록 수가 이미지 삽입에 충분하지 않습니다.");
  blocks.splice(Math.min(3, blocks.length), 0, imageBlock(images[0]));
  blocks.splice(Math.min(7, blocks.length), 0, imageBlock(images[1]));
  return blocks.join("\n\n");
}

async function jsonResponse(response, errorType) {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch {
    throw attachTrialDiagnostic(new Error("응답 JSON 해석 실패"), errorType, {httpStatus: response.status});
  }
}

async function getAllPosts({base, headers}) {
  const posts = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetch(`${base}/wp-json/wp/v2/posts?context=edit&status=draft,pending,future,publish,private,trash&per_page=100&page=${page}&orderby=id&order=asc&_fields=id,title`, {method: "GET", headers});
    if (response.status !== 200) throw attachTrialDiagnostic(new Error("글 목록 조회 실패"), "article_response", {httpStatus: response.status});
    const data = await jsonResponse(response, "article_response");
    if (!Array.isArray(data)) throw attachTrialDiagnostic(new Error("글 목록 형식 오류"), "article_response", {httpStatus: response.status});
    posts.push(...data);
    const pages = Number(response.headers.get("x-wp-totalpages"));
    if (!Number.isInteger(pages) || pages < 1 || pages > 30) throw new Error("글 목록 페이지 정보 오류");
    if (page === pages) return posts;
  }
  throw new Error("글 목록이 너무 많아 안전하게 확인하지 못했습니다.");
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
          "Write only editable Gutenberg HTML for a Korean informational travel-climate article.",
          `Title: ${plan.title}`,
          "Compare Santiago, Chile and Mendoza, Argentina across seasons, explaining the Andes rain-shadow context carefully.",
          `Use these sources as a fact-checking checklist and include a short sources section with these URLs: ${plan.sources.join(" ")}`,
          "Use h2 headings, paragraphs, and a comparison table. Do not use h1, Markdown, scripts, iframes, or unsupported claims.",
          `SEO keyword: ${plan.seo.keyword}`,
        ].join("\n")}],
      }),
    });
  } catch (error) {
    throw attachTrialDiagnostic(error, "article_api");
  }
  const data = await jsonResponse(response, "article_response");
  if (!response.ok) throw attachTrialDiagnostic(new Error("본문 API 실패"), "article_api", {httpStatus: response.status, openAiCode: safeOpenAiCode(data)});
  if (data.status === "incomplete") throw attachTrialDiagnostic(new Error("본문 출력 중단"), "article_incomplete", {finishReason: data.incomplete_details?.reason});
  const html = String(data.output_text || "").trim();
  if (!html) throw attachTrialDiagnostic(new Error("본문 비어 있음"), "article_empty", {httpStatus: response.status});
  const characterCount = html.replace(/<[^>]*>/g, "").replace(/\s/g, "").length;
  if (characterCount < 3000) throw attachTrialDiagnostic(new Error("본문 분량 미달"), "article_too_short", {characterCount, minimumCharacterCount: 3000});
  if (!/<!--\s*wp:/i.test(html) || /<h1\b/i.test(html)) throw attachTrialDiagnostic(new Error("Gutenberg HTML 검증 실패"), "article_html_invalid", {htmlRule: "gutenberg_or_h1", characterCount});
  return html;
}

async function createAndUploadImage({apiKey, base, headers, image, title}) {
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

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_WORKFLOW_REF !== "kkamskim22-cell/makeit-middle-kit/.github/workflows/site-03-image-draft-followup.yml@refs/heads/main" || process.env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error("전용 후속 워크플로의 최초 시도에서만 실행할 수 있습니다.");
  }
  const env = requireLicense({scriptLabel: "사이트 3 이미지 포함 임시글"});
  const plan = validateImageDraftPlan(JSON.parse(readFileSync(planPath, "utf8")));
  const base = siteUrl(env.ADSENSE_SITE_03_URL);
  const headers = {...browserHeaders(base), Authorization: authorization(env.ADSENSE_SITE_03_USER, env.ADSENSE_SITE_03_APP_PASSWORD), Accept: "application/json"};
  const parentId = positiveInteger(argument("parent-category-id"));
  const childId = positiveInteger(argument("child-category-id"));
  if (!base || !parentId || !childId) throw new Error("확인된 상위·세부 카테고리 ID가 필요합니다.");
  let stage = "preflight";
  try {
    const categories = await getAllCategories({base, headers});
    const posts = await getAllPosts({base, headers});
    const history = [...readRecoveredHistory(recoveredPath), ...readTrialVerifiedHistory(trialHistoryPath)];
    assertPlanTitleUnused(plan, [...posts.map((post) => post?.title?.raw), ...history.map((entry) => entry.title)]);
    const child = categories.find((category) => category.id === childId && category.parent === parentId);
    const parent = categories.find((category) => category.id === parentId && category.parent === 0);
    if (!parent || !child) throw new Error("기존 카테고리 4-3의 상위·세부 ID 관계를 확인하지 못했습니다.");
    stage = "article_generation";
    const article = await createArticle({apiKey: env.OPENAI_API_KEY, plan});
    stage = "image_generation";
    const featuredPlan = plan.images.find((image) => image.role === "featured");
    const inlinePlans = plan.images.filter((image) => image.role === "inline");
    const featured = await createAndUploadImage({apiKey: env.OPENAI_API_KEY, base, headers, image: featuredPlan, title: plan.title});
    const inline = [];
    for (const image of inlinePlans) inline.push(await createAndUploadImage({apiKey: env.OPENAI_API_KEY, base, headers, image, title: plan.title}));
    const content = insertInlineImages(article, inline);
    stage = "wordpress_draft_create";
    const createdResponse = await fetch(`${base}/wp-json/wp/v2/posts?context=edit`, {method: "POST", headers: {...headers, "Content-Type": "application/json"}, body: JSON.stringify({title: plan.title, content, status: "draft", categories: [parentId, childId], featured_media: featured.id, excerpt: plan.seo.description})});
    const created = await jsonResponse(createdResponse, "article_response");
    if (!createdResponse.ok || !Number.isSafeInteger(created.id)) throw attachTrialDiagnostic(new Error("임시글 생성 실패"), "article_response", {httpStatus: createdResponse.status});
    stage = "wordpress_draft_verify";
    const postResponse = await fetch(`${base}/wp-json/wp/v2/posts/${created.id}?context=edit&_fields=id,title,content,excerpt,status,categories,featured_media`, {method: "GET", headers});
    const post = await jsonResponse(postResponse, "article_response");
    if (!postResponse.ok) throw attachTrialDiagnostic(new Error("임시글 재조회 실패"), "article_response", {httpStatus: postResponse.status});
    const verify = verifyDraftPostRequirements({post, plan, parentId, childId, media: [{id: featured.id, source_url: featured.sourceUrl, alt_text: featured.altText}, ...inline.map((item) => ({id: item.id, source_url: item.sourceUrl, alt_text: item.altText}))], featuredMediaId: featured.id, inlineMediaIds: inline.map((item) => item.id)});
    console.log(JSON.stringify({site: 3, status: "draft", postId: post.id, imageCount: verify.imageCount, inlineImageCount: verify.inlineImageCount, duplicate: false}));
  } catch (error) {
    console.error(JSON.stringify({site: 3, ...safeTrialDiagnostic(error, stage)}));
    process.exitCode = 1;
  }
}

main();
