import {attachTrialDiagnostic} from "./site-03-trial-diagnostics.mjs";

export const ARTICLE_MINIMUM_CHARACTER_COUNT = 1300;

function responseFailure(errorType, details = {}) {
  return attachTrialDiagnostic(new Error(errorType), errorType, details);
}

function validateOutputShape(data, httpStatus) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.status !== "completed") {
    throw responseFailure("article_response", {httpStatus});
  }
  if (data.output_text !== undefined && typeof data.output_text !== "string") {
    throw responseFailure("article_response", {httpStatus});
  }
  if (!Array.isArray(data.output)) throw responseFailure("article_response", {httpStatus});
  for (const item of data.output) {
    if (!item || typeof item !== "object" || (item.content !== undefined && !Array.isArray(item.content))) {
      throw responseFailure("article_response", {httpStatus});
    }
    for (const content of item.content || []) {
      if (!content || typeof content !== "object" ||
          (content.text !== undefined && typeof content.text !== "string") ||
          (content.output_text !== undefined && typeof content.output_text !== "string")) {
        throw responseFailure("article_response", {httpStatus});
      }
    }
  }
}

export function extractArticleOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string" && content.text.trim()) parts.push(content.text);
      if (typeof content.output_text === "string" && content.output_text.trim()) parts.push(content.output_text);
    }
  }
  return parts.join("\n").trim();
}

function stripHtmlTags(html) {
  let text = "";
  let inTag = false;
  let quote = "";
  for (const character of String(html || "")) {
    if (!inTag) {
      if (character === "<") inTag = true;
      else text += character;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") inTag = false;
  }
  return text;
}

export function countArticleCharacters(html) {
  const visibleText = stripHtmlTags(html)
    .replace(/&(?:nbsp|ensp|emsp|emsp13|emsp14|numsp|puncsp|thinsp|hairsp|Tab|NewLine|MediumSpace|ThickSpace|VeryThinSpace|ZeroWidthSpace);/gi, " ")
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_entity, encoded) => {
      const codePoint = encoded[0].toLowerCase() === "x"
        ? Number.parseInt(encoded.slice(1), 16)
        : Number.parseInt(encoded, 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : "X";
    })
    .replace(/&[a-z][a-z0-9]+;/gi, "X")
    .replace(/[\s\u200b-\u200d\u2060\ufeff]/g, "");
  return Array.from(visibleText).length;
}

const GUTENBERG_BLOCKS = new Set(["paragraph", "heading", "table", "list", "list-item", "image"]);

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function plainText(value) {
  return typeof value === "string" && value.trim() && value.length <= 4000 && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function headingBlock(text) {
  return `<!-- wp:heading -->\n<h2 class="wp-block-heading">${escapeHtml(text.trim())}</h2>\n<!-- /wp:heading -->`;
}

function paragraphBlock(text) {
  return `<!-- wp:paragraph -->\n<p>${escapeHtml(text.trim())}</p>\n<!-- /wp:paragraph -->`;
}

function validateStructuredDocument(document, expectedSources) {
  if (!exactKeys(document, ["sections", "table", "checklist", "sources"]) ||
      !Array.isArray(document.sections) || document.sections.length !== 5 ||
      !document.sections.every((section) => exactKeys(section, ["heading", "paragraphs"]) && plainText(section.heading) &&
        Array.isArray(section.paragraphs) && section.paragraphs.length >= 2 && section.paragraphs.length <= 3 && section.paragraphs.every(plainText)) ||
      !exactKeys(document.table, ["headers", "rows"]) || !Array.isArray(document.table.headers) || document.table.headers.length !== 3 ||
      !document.table.headers.every(plainText) || !Array.isArray(document.table.rows) || document.table.rows.length < 2 || document.table.rows.length > 8 ||
      !document.table.rows.every((row) => Array.isArray(row) && row.length === 3 && row.every(plainText)) ||
      !Array.isArray(document.checklist) || document.checklist.length < 3 || document.checklist.length > 6 || !document.checklist.every(plainText) ||
      !Array.isArray(document.sources) || !Array.isArray(expectedSources) || document.sources.length !== expectedSources.length ||
      !document.sources.every((source, index) => source === expectedSources[index])) {
    throw responseFailure("article_structure_invalid");
  }
  return document;
}

function buildStructuredGutenberg(document) {
  const blocks = [];
  for (const section of document.sections) {
    blocks.push(headingBlock(section.heading));
    blocks.push(...section.paragraphs.map(paragraphBlock));
  }
  const header = document.table.headers.map((cell) => `<th>${escapeHtml(cell.trim())}</th>`).join("");
  const rows = document.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell.trim())}</td>`).join("")}</tr>`).join("");
  blocks.push(`<!-- wp:table {"hasFixedLayout":true} -->\n<figure class="wp-block-table"><table class="has-fixed-layout"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></figure>\n<!-- /wp:table -->`);
  blocks.push(headingBlock("여행 전 확인할 점"));
  const items = document.checklist.map((item) => `<!-- wp:list-item -->\n<li>${escapeHtml(item.trim())}</li>\n<!-- /wp:list-item -->`).join("\n");
  blocks.push(`<!-- wp:list -->\n<ul class="wp-block-list">\n${items}\n</ul>\n<!-- /wp:list -->`);
  blocks.push(headingBlock("출처"));
  blocks.push(paragraphBlock(document.sources.join(" ")));
  return blocks.join("\n\n");
}

export function splitTopLevelGutenbergBlocks(html) {
  const source = String(html || "").trim();
  const token = /<!--\s*(\/?)wp:([a-z0-9-]+)(?:\s+(\{[\s\S]*?\}))?\s*-->/gi;
  const stack = [];
  const blocks = [];
  let cursor = 0;
  let blockStart = -1;
  let match;
  while ((match = token.exec(source)) !== null) {
    if (stack.length === 0 && source.slice(cursor, match.index).trim()) throw new Error("Gutenberg 블록 밖의 내용이 있습니다.");
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    if (!GUTENBERG_BLOCKS.has(name)) throw new Error("허용되지 않은 Gutenberg 블록입니다.");
    if (match[3]) {
      try { JSON.parse(match[3]); } catch { throw new Error("Gutenberg 블록 속성이 올바르지 않습니다."); }
    }
    if (closing) {
      if (stack.pop() !== name) throw new Error("Gutenberg 블록 짝이 맞지 않습니다.");
      if (stack.length === 0) {
        blocks.push({name, html: source.slice(blockStart, token.lastIndex)});
        blockStart = -1;
      }
    } else {
      if (stack.length === 0) blockStart = match.index;
      stack.push(name);
    }
    cursor = token.lastIndex;
  }
  if (stack.length || blockStart >= 0 || source.slice(cursor).trim() || blocks.length === 0) throw new Error("Gutenberg 블록 구조가 완전하지 않습니다.");
  return blocks;
}

function blockMarkupValid(block) {
  if (block.name === "paragraph") return /^<!--\s*wp:paragraph\s*-->\s*<p>[^<]*<\/p>\s*<!--\s*\/wp:paragraph\s*-->$/i.test(block.html);
  if (block.name === "heading") return /^<!--\s*wp:heading\s*-->\s*<h2 class="wp-block-heading">[^<]+<\/h2>\s*<!--\s*\/wp:heading\s*-->$/i.test(block.html);
  if (block.name === "table") return /^<!--\s*wp:table\s+\{"hasFixedLayout":true\}\s*-->\s*<figure class="wp-block-table"><table class="has-fixed-layout"><thead><tr>(?:<th>[^<]+<\/th>){3}<\/tr><\/thead><tbody>(?:<tr>(?:<td>[^<]+<\/td>){3}<\/tr>){2,8}<\/tbody><\/table><\/figure>\s*<!--\s*\/wp:table\s*-->$/i.test(block.html);
  if (block.name === "list") return /^<!--\s*wp:list\s*-->\s*<ul class="wp-block-list">(?:\s*<!--\s*wp:list-item\s*-->\s*<li>[^<]+<\/li>\s*<!--\s*\/wp:list-item\s*-->){3,6}\s*<\/ul>\s*<!--\s*\/wp:list\s*-->$/i.test(block.html);
  if (block.name === "image") return /^<!--\s*wp:image\s+\{"id":\d+,"sizeSlug":"large","linkDestination":"none"\}\s*-->\s*<figure class="wp-block-image size-large"><img src="https:\/\/[^"<>]+" alt="[^"<>]+" class="wp-image-\d+"><figcaption>[^<>]+<\/figcaption><\/figure>\s*<!--\s*\/wp:image\s*-->$/i.test(block.html);
  return false;
}

export function validateGutenbergArticle(html, {requireTravelArticleStructure = false, expectedImages = []} = {}) {
  if (/<h1(?:\s|>)/i.test(html) || /<\s*\/?\s*(?:script|style|iframe|object|embed|form|input|button)\b|\son[a-z]+\s*=|javascript\s*:/i.test(html)) {
    throw new Error("허용되지 않은 HTML입니다.");
  }
  const blocks = splitTopLevelGutenbergBlocks(html);
  if (!blocks.every(blockMarkupValid)) throw new Error("Gutenberg 블록 본문이 올바르지 않습니다.");
  const count = (name) => blocks.filter((block) => block.name === name).length;
  const imageDetails = blocks.filter((block) => block.name === "image").map((block) => ({
    id: Number(block.html.match(/"id":(\d+)/)?.[1]),
    cssId: Number(block.html.match(/class="wp-image-(\d+)"/)?.[1]),
    sourceUrl: block.html.match(/<img src="([^"]+)"/)?.[1] || "",
  }));
  if (requireTravelArticleStructure && (count("heading") < 7 || count("paragraph") < 11 || count("table") !== 1 || count("list") !== 1)) {
    throw new Error("필수 Gutenberg 블록이 없습니다.");
  }
  if (imageDetails.length !== expectedImages.length || imageDetails.some((image, index) => {
    const expected = expectedImages[index];
    return image.id !== expected?.id || image.cssId !== expected?.id || image.sourceUrl !== escapeHtml(expected?.sourceUrl || "");
  })) {
    throw new Error("Gutenberg 이미지 블록이 일치하지 않습니다.");
  }
  return {headingCount: count("heading"), paragraphCount: count("paragraph"), tableCount: count("table"), listCount: count("list"), imageCount: imageDetails.length};
}

export function countArticleBodyCharacters(html) {
  const body = splitTopLevelGutenbergBlocks(html)
    .filter((block) => block.name !== "image")
    .map((block) => block.html)
    .join("\n");
  return countArticleCharacters(body);
}

function validateExistingGutenberg(html, {characterCount, requireTravelArticleStructure}) {
  const hasGutenbergBlocks = /<!--\s*\/?wp:/i.test(html);
  const hasH1 = /<h1(?:\s|>)/i.test(html);
  if (hasH1) throw responseFailure("article_h1_forbidden", {characterCount, hasGutenbergBlocks, hasH1});
  if (!hasGutenbergBlocks) throw responseFailure("article_gutenberg_missing", {characterCount, hasGutenbergBlocks, hasH1});
  try {
    validateGutenbergArticle(html, {requireTravelArticleStructure});
  } catch {
    throw responseFailure("article_gutenberg_structure", {characterCount, requiredBlocks: []});
  }
  return html;
}

export function parseArticleResponseData({
  data,
  httpStatus = 200,
  minimumCharacterCount = ARTICLE_MINIMUM_CHARACTER_COUNT,
  requireTravelArticleStructure = false,
}) {
  if (data?.status === "incomplete") {
    throw responseFailure("article_incomplete", {finishReason: data.incomplete_details?.reason});
  }
  validateOutputShape(data, httpStatus);
  const html = extractArticleOutputText(data);
  if (!html) throw responseFailure("article_empty", {httpStatus});
  const characterCount = countArticleCharacters(html);
  if (characterCount < minimumCharacterCount) {
    throw responseFailure("article_too_short", {characterCount, minimumCharacterCount});
  }
  return validateExistingGutenberg(html, {characterCount, requireTravelArticleStructure});
}

export function parseStructuredArticleResponseData({
  data,
  httpStatus = 200,
  minimumCharacterCount = ARTICLE_MINIMUM_CHARACTER_COUNT,
  expectedSources,
}) {
  if (data?.status === "incomplete") throw responseFailure("article_incomplete", {finishReason: data.incomplete_details?.reason});
  validateOutputShape(data, httpStatus);
  const output = extractArticleOutputText(data);
  if (!output) throw responseFailure("article_empty", {httpStatus});
  let document;
  try {
    document = JSON.parse(output);
  } catch {
    const characterCount = countArticleCharacters(output);
    const hasGutenbergBlocks = /<!--\s*\/?wp:/i.test(output);
    const hasH1 = /<h1(?:\s|>)/i.test(output);
    if (hasH1) throw responseFailure("article_h1_forbidden", {characterCount, hasGutenbergBlocks, hasH1});
    if (/<[a-z!/][\s\S]*>/i.test(output)) {
      if (!hasGutenbergBlocks) throw responseFailure("article_gutenberg_missing", {characterCount, hasGutenbergBlocks, hasH1});
      throw responseFailure("article_gutenberg_structure", {characterCount, requiredBlocks: []});
    }
    throw responseFailure("article_structure_invalid");
  }
  const html = buildStructuredGutenberg(validateStructuredDocument(document, expectedSources));
  const characterCount = countArticleCharacters(html);
  if (characterCount < minimumCharacterCount) throw responseFailure("article_too_short", {characterCount, minimumCharacterCount});
  try { validateGutenbergArticle(html, {requireTravelArticleStructure: true}); }
  catch { throw responseFailure("article_gutenberg_structure", {characterCount, requiredBlocks: []}); }
  return html;
}
