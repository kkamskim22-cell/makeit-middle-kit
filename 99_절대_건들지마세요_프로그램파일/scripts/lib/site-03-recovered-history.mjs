import {readFileSync} from "node:fs";

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}이 없습니다.`);
  return value.trim();
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label}이 올바르지 않습니다.`);
  return value;
}

export function validateRecoveredHistory(records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error("복구 이력이 비어 있습니다.");
  const titles = new Set();
  const postIds = new Set();
  for (const record of records) {
    if (record?.ok !== true) throw new Error("복구 이력이 성공 생성 기록이 아닙니다.");
    if (record?.site !== 3) throw new Error("사이트 3 이력이 아닙니다.");
    const title = requiredString(record.title, "제목");
    const postId = requiredPositiveInteger(record.postId, "글 ID");
    if (record.status !== "draft") throw new Error("복구 이력 상태가 draft가 아닙니다.");
    if (titles.has(title) || postIds.has(postId)) throw new Error("복구 이력에 중복 제목 또는 글 ID가 있습니다.");
    if (record?.recovery?.source !== "github-actions-log") throw new Error("복구 출처가 GitHub Actions 로그가 아닙니다.");
    requiredPositiveInteger(record.recovery.runId, "실행 ID");
    requiredPositiveInteger(record.recovery.jobId, "작업 ID");
    titles.add(title);
    postIds.add(postId);
  }
  return records;
}

export function readRecoveredHistory(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  if (document?.source !== "github-actions-log-recovery" || !Array.isArray(document.records)) {
    throw new Error("복구 이력 문서 형식이 올바르지 않습니다.");
  }
  return validateRecoveredHistory(document.records);
}

export function readTrialVerifiedHistory(path) {
  const document = JSON.parse(readFileSync(path, "utf8"));
  if (document?.source !== "site-03-trial-workflow" || !Array.isArray(document.records)) {
    throw new Error("시험 검증 이력 문서 형식이 올바르지 않습니다.");
  }
  for (const record of document.records) {
    if (record?.ok !== true || record?.site !== 3 || typeof record.title !== "string" || !record.title.trim() ||
        !Number.isSafeInteger(record.postId) || record.postId <= 0 || record.status !== "draft" ||
        !Array.isArray(record.categoryIds) || record.categoryIds.length === 0 ||
        record?.recovery?.source !== "site-03-trial-workflow" || record.recovery.verified !== true ||
        !Number.isSafeInteger(record.recovery.runId) || record.recovery.runId <= 0) {
      throw new Error("시험 검증 이력의 출처 또는 검증 상태가 올바르지 않습니다.");
    }
  }
  return document.records;
}

export async function verifyRecoveredHistory({siteBase, headers, records, request}) {
  validateRecoveredHistory(records);
  const base = String(siteBase || "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("사이트 주소가 올바르지 않습니다.");
  const changedPostIds = [];
  const deletedPostIds = [];
  const inaccessiblePostIds = [];
  for (const record of records) {
    const url = `${base}/wp-json/wp/v2/posts/${record.postId}?context=edit&_fields=id,title,status`;
    const response = await request(url, {method: "GET", headers});
    if (response.status === 404) {
      deletedPostIds.push(record.postId);
      continue;
    }
    if (response.status !== 200) {
      inaccessiblePostIds.push(record.postId);
      continue;
    }
    const current = await response.json();
    if (current?.id !== record.postId || typeof current?.title?.raw !== "string") {
      inaccessiblePostIds.push(record.postId);
      continue;
    }
    if (current.title.raw !== record.title) changedPostIds.push(record.postId);
  }
  return {
    verifiedCount: records.length,
    excludedTitles: records.map((record) => record.title),
    changedPostIds,
    deletedPostIds,
    inaccessiblePostIds,
  };
}
