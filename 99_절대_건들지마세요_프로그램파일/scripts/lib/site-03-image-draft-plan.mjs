function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}이 없습니다.`);
  return value.trim();
}

export function normalizedTitleKey(value) {
  return String(value || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function visibleText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .normalize("NFC")
    .toLowerCase();
}

function tokenStem(value) {
  return String(value || "").replace(/(?:으로|에서|에게|까지|부터|처럼|보다|이나|거나|은|는|이|가|을|를|의|에|와|과|로)$/u, "");
}

function textTokens(value) {
  return (visibleText(value).match(/[\p{L}\p{N}]+/gu) || []).map(tokenStem).filter((token) => token.length >= 2);
}

function tokenSimilarity(left, right) {
  const a = new Set(textTokens(left));
  const b = new Set(textTokens(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

const GENERIC_TITLE_TOKENS = new Set(["세계", "여행지", "계절", "비교", "이유", "방법", "사이", "지역"]);

function coreTitleTokens(value) {
  return new Set(textTokens(value).filter((token) => !GENERIC_TITLE_TOKENS.has(token)));
}

function titlesAreSimilar(target, candidate) {
  if (normalizedTitleKey(target) === normalizedTitleKey(candidate)) return true;
  const targetCore = coreTitleTokens(target);
  const candidateCore = coreTitleTokens(candidate);
  if (targetCore.size >= 2) return [...targetCore].every((token) => candidateCore.has(token));
  return tokenSimilarity(target, candidate) >= 0.6;
}

function shingles(value, size = 5) {
  const tokens = textTokens(value);
  const result = new Set();
  for (let index = 0; index <= tokens.length - size; index += 1) result.add(tokens.slice(index, index + size).join(" "));
  return result;
}

export function validateImageDraftPlan(plan) {
  requiredText(plan?.title, "제목");
  if (!/^\d+-\d+$/.test(String(plan?.categoryKey || ""))) throw new Error("세부 카테고리 키 형식이 올바르지 않습니다.");
  for (const field of ["title", "description", "keyword"]) requiredText(plan?.seo?.[field], `SEO ${field}`);
  if (normalizedTitleKey(plan.seo.title) !== normalizedTitleKey(plan.title)) throw new Error("SEO title은 글 제목과 같아야 합니다.");
  if (!Array.isArray(plan?.sources) || plan.sources.length < 3 || plan.sources.some((source) => !/^https:\/\//.test(source))) {
    throw new Error("확인 가능한 지리·기후 근거가 부족합니다.");
  }
  if (!Array.isArray(plan?.images) || plan.images.length !== 3) throw new Error("대표 이미지 1개와 본문 이미지 2개가 필요합니다.");
  const roles = plan.images.map((image) => image?.role).sort();
  if (JSON.stringify(roles) !== JSON.stringify(["featured", "inline", "inline"])) throw new Error("이미지 역할 구성이 올바르지 않습니다.");
  const placements = new Set();
  for (const image of plan.images) {
    requiredText(image?.alt, "이미지 대체 텍스트");
    requiredText(image?.scene, "이미지 장면");
    const placement = requiredText(image?.placement, "이미지 위치");
    if (placements.has(placement)) throw new Error("이미지 위치가 중복됩니다.");
    placements.add(placement);
  }
  return plan;
}

export function assertPlanTitleUnused(plan, usedTitles) {
  const key = normalizedTitleKey(plan?.title);
  if ((usedTitles || []).map(normalizedTitleKey).includes(key)) throw new Error("지정 제목이 기존 글 또는 이력과 중복됩니다.");
  return true;
}

export function matchingTitlePostIds(title, posts) {
  const key = normalizedTitleKey(title);
  return (posts || [])
    .filter((post) => normalizedTitleKey(post?.title?.raw || post?.title?.rendered) === key)
    .map((post) => post.id);
}

export function assessPlanSimilarity(plan, posts) {
  const similarTitlePostIds = [];
  const topicBodyPostIds = [];
  const markers = (plan?.locations || []).map((location) => textTokens(location).at(-1)).filter(Boolean);
  for (const post of posts || []) {
    const title = post?.title?.raw || post?.title?.rendered || "";
    if (titlesAreSimilar(plan?.title, title)) similarTitlePostIds.push(post.id);
    const content = visibleText(post?.content?.raw || post?.content?.rendered || "");
    if (markers.length >= 2 && markers.every((marker) => content.includes(marker))) topicBodyPostIds.push(post.id);
  }
  return {
    similarTitlePostIds,
    topicBodyPostIds,
    any: similarTitlePostIds.length > 0 || topicBodyPostIds.length > 0,
  };
}

export function assertArticleContentDistinct(articleHtml, posts) {
  const articleShingles = shingles(articleHtml);
  for (const post of posts || []) {
    const existingShingles = shingles(post?.content?.raw || post?.content?.rendered || "");
    const denominator = Math.min(articleShingles.size, existingShingles.size);
    if (!denominator) continue;
    const overlap = [...articleShingles].filter((item) => existingShingles.has(item)).length / denominator;
    if (overlap >= 0.3) throw new Error("새 본문이 기존 본문과 유사하여 생성을 중단합니다.");
  }
  return true;
}

export function verifyImageDraftRecord({post, media, featuredMediaId, inlineMediaIds}) {
  if (post?.status !== "draft") throw new Error("글이 draft 상태가 아닙니다.");
  if (post?.featured_media !== featuredMediaId) throw new Error("대표 이미지가 연결되지 않았습니다.");
  const allIds = [featuredMediaId, ...(inlineMediaIds || [])];
  if (allIds.length !== 3 || new Set(allIds).size !== 3) throw new Error("이미지 ID 구성이 올바르지 않습니다.");
  const content = String(post?.content?.raw || "");
  const featured = (media || []).find((candidate) => candidate?.id === featuredMediaId);
  if (!featured?.source_url || !featured?.alt_text) throw new Error("대표 이미지의 URL 또는 대체 텍스트를 확인하지 못했습니다.");
  if (content.includes(`wp-image-${featuredMediaId}`)) throw new Error("대표 이미지가 본문에 중복 삽입되었습니다.");
  for (const id of inlineMediaIds || []) {
    const item = (media || []).find((candidate) => candidate?.id === id);
    if (!item?.source_url || !item?.alt_text) throw new Error("업로드 이미지의 URL 또는 대체 텍스트를 확인하지 못했습니다.");
    if (!content.includes(`wp-image-${id}`)) throw new Error("본문 이미지 블록을 확인하지 못했습니다.");
  }
  return {imageCount: allIds.length, inlineImageCount: inlineMediaIds.length, status: post.status};
}

export function verifyDraftPostRequirements({post, plan, parentId, childId, media, featuredMediaId, inlineMediaIds}) {
  if (post?.title?.raw !== plan?.title) throw new Error("글 제목을 다시 확인하지 못했습니다.");
  if (!Array.isArray(post?.categories) || !post.categories.includes(parentId) || !post.categories.includes(childId)) {
    throw new Error("상위·세부 카테고리를 다시 확인하지 못했습니다.");
  }
  if (post?.excerpt?.raw !== plan?.seo?.description) throw new Error("SEO 요약문을 다시 확인하지 못했습니다.");
  const content = String(post?.content?.raw || "");
  if (!content.includes(plan?.seo?.keyword || "")) throw new Error("SEO 핵심 키워드를 본문에서 다시 확인하지 못했습니다.");
  if (!(plan?.sources || []).every((source) => content.includes(source))) throw new Error("본문 출처를 다시 확인하지 못했습니다.");
  return verifyImageDraftRecord({post, media, featuredMediaId, inlineMediaIds});
}
