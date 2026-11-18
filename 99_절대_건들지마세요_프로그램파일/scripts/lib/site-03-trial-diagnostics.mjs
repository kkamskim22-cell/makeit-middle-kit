const ERROR_TYPES = new Set([
  "meta_api",
  "meta_response",
  "article_api",
  "article_response",
  "article_incomplete",
  "article_empty",
  "article_html_invalid",
  "article_too_short",
]);

function safeText(value, maximum = 80) {
  const text = String(value || "").trim();
  return /^[a-z0-9_.-]+$/i.test(text) ? text.slice(0, maximum) : null;
}

function safeHttpStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

export function trialFailure(errorType, details = {}) {
  const error = new Error(errorType);
  error.trialDiagnostic = {errorType, ...details};
  return error;
}

export function attachTrialDiagnostic(error, errorType, details = {}) {
  const target = error instanceof Error ? error : new Error("trial failure");
  target.trialDiagnostic = {errorType, ...details};
  return target;
}

export function safeTrialDiagnostic(error, stage) {
  const source = error?.trialDiagnostic || {};
  const errorType = ERROR_TYPES.has(source.errorType) ? source.errorType : "article_response";
  const result = {stage: safeText(stage) || "unknown", errorType};
  const httpStatus = safeHttpStatus(source.httpStatus);
  const openAiCode = safeText(source.openAiCode);
  const finishReason = safeText(source.finishReason);
  const htmlRule = safeText(source.htmlRule);
  const characterCount = Number.isInteger(source.characterCount) && source.characterCount >= 0 ? source.characterCount : null;
  const minimumCharacterCount = Number.isInteger(source.minimumCharacterCount) && source.minimumCharacterCount >= 0 ? source.minimumCharacterCount : null;
  if (httpStatus !== null) result.httpStatus = httpStatus;
  if (openAiCode) result.openAiCode = openAiCode;
  if (finishReason) result.finishReason = finishReason;
  if (htmlRule) result.htmlRule = htmlRule;
  if (characterCount !== null) result.characterCount = characterCount;
  if (minimumCharacterCount !== null) result.minimumCharacterCount = minimumCharacterCount;
  return result;
}

export function safeOpenAiCode(data) {
  return safeText(data?.error?.code || data?.error?.type);
}
