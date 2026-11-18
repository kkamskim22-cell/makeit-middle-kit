import {attachTrialDiagnostic} from "./site-03-trial-diagnostics.mjs";

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

export function parseArticleResponseData({data, httpStatus = 200, minimumCharacterCount = 3000}) {
  if (data?.status === "incomplete") {
    throw responseFailure("article_incomplete", {finishReason: data.incomplete_details?.reason});
  }
  validateOutputShape(data, httpStatus);
  const html = extractArticleOutputText(data);
  if (!html) throw responseFailure("article_empty", {httpStatus});
  const characterCount = html.replace(/<[^>]*>/g, "").replace(/\s/g, "").length;
  if (characterCount < minimumCharacterCount) {
    throw responseFailure("article_too_short", {characterCount, minimumCharacterCount});
  }
  if (!/<!--\s*wp:/i.test(html) || /<h1\b/i.test(html)) {
    throw responseFailure("article_html_invalid", {htmlRule: "gutenberg_or_h1", characterCount});
  }
  return html;
}
