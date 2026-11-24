function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label}이 없습니다.`);
  return text;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function visibleText(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160|#x0*a0);/gi, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordSlug(value) {
  return String(value || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export function validateSite03Seo(seo) {
  const focusKeyword = requiredText(seo?.keyword, "포커스 키워드");
  const title = requiredText(seo?.title, "SEO 제목");
  const description = requiredText(seo?.description, "메타 설명");
  const slug = requiredText(seo?.slug, "SEO URL");
  if (!title.includes(focusKeyword)) throw new Error("SEO 제목에 포커스 키워드가 없습니다.");
  if (!description.includes(focusKeyword)) throw new Error("메타 설명에 포커스 키워드가 없습니다.");
  if (keywordSlug(slug) !== keywordSlug(focusKeyword)) throw new Error("SEO URL에 동일한 포커스 키워드가 반영되지 않았습니다.");
  return {focusKeyword, title, description, slug};
}

export function site03SeoSlugMatches(actual, expected) {
  try {
    return keywordSlug(decodeURIComponent(String(actual || ""))) === keywordSlug(expected);
  } catch {
    return false;
  }
}

export function applyFocusKeywordToFirstParagraph(html, keyword) {
  const focusKeyword = requiredText(keyword, "포커스 키워드");
  const source = String(html || "");
  const paragraph = /(<!-- wp:paragraph -->\s*<p>)([\s\S]*?)(<\/p>\s*<!-- \/wp:paragraph -->)/u;
  const match = source.match(paragraph);
  if (!match) throw new Error("첫 Gutenberg 문단을 찾지 못했습니다.");
  if (visibleText(match[2]).includes(focusKeyword)) return source;
  const prefix = `${escapeHtml(focusKeyword)}를 살펴보려면 두 도시의 위치와 산맥이 만드는 기후 조건부터 이해할 필요가 있습니다. `;
  return source.replace(paragraph, `$1${prefix}$2$3`);
}

export function estimateVisibleWordCount(html) {
  const text = visibleText(html);
  return text ? text.split(/\s+/u).length : 0;
}

export function buildSite03DraftPayload({plan, content, parentId, childId, featuredMediaId}) {
  const seo = validateSite03Seo(plan?.seo);
  const firstParagraph = String(content || "").match(/<!-- wp:paragraph -->\s*<p>([\s\S]*?)<\/p>\s*<!-- \/wp:paragraph -->/u)?.[1] || "";
  if (!visibleText(firstParagraph).includes(seo.focusKeyword)) throw new Error("본문 첫 문단에 포커스 키워드가 없습니다.");
  return {
    title: requiredText(plan?.title, "글 제목"),
    content,
    status: "draft",
    slug: seo.slug,
    categories: [parentId, childId],
    featured_media: featuredMediaId,
    excerpt: seo.description,
  };
}

export async function saveRankMathMetadata({base, headers, postId, seo, request = fetch}) {
  const metadata = validateSite03Seo(seo);
  const response = await request(`${String(base || "").replace(/\/+$/, "")}/wp-json/rankmath/v1/updateMeta`, {
    method: "POST",
    redirect: "error",
    headers: {...headers, "Content-Type": "application/json"},
    body: JSON.stringify({
      objectID: Number(postId),
      objectType: "post",
      meta: {
        rank_math_focus_keyword: metadata.focusKeyword,
        rank_math_title: metadata.title,
        rank_math_description: metadata.description,
      },
    }),
  });
  if (!response.ok) {
    const error = new Error("Rank Math 메타데이터 저장 실패");
    error.httpStatus = response.status;
    throw error;
  }
  return {saved: true, httpStatus: response.status, focusKeyword: metadata.focusKeyword};
}
