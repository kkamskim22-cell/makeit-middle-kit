#!/usr/bin/env node

import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {browserHeaders} from "./lib/wp.mjs";
import {PROGRAM_ROOT, PROJECT_ROOT} from "./lib/env.mjs";
import {readRecoveredHistory, readTrialVerifiedHistory} from "./lib/site-03-recovered-history.mjs";
import {assessPlanSimilarity, normalizedTitleKey} from "./lib/site-03-image-draft-plan.mjs";
import {readTitleEntries, resolveTitleFile} from "./title-files.mjs";

const SITE = 3;
const TARGET_TITLE = "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교";
const TARGET_CATEGORY_KEY = "4-3";
const EXPECTED_CHILD_NAME = "바다와 지형이 만드는 계절 차이";

function normalizedText(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedSiteUrl(value) {
  const raw = String(value || "").trim().replace(/^['"]+|['"]+$/g, "");
  if (!raw) return "";
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
}

function safeFailure(stage, details = {}) {
  const error = new Error(stage);
  error.safeDiagnostic = {stage, ...details};
  return error;
}

async function readAllPages({url, headers, request, stage}) {
  const records = [];
  const statuses = [];
  let expectedTotal = null;
  let expectedPages = null;
  for (let page = 1; page <= 30; page += 1) {
    url.searchParams.set("page", String(page));
    let response;
    try {
      response = await request(url.toString(), {method: "GET", headers});
    } catch {
      throw safeFailure(stage, {reason: "network_error"});
    }
    statuses.push(response.status);
    if (response.status !== 200) throw safeFailure(stage, {httpStatus: response.status});
    let data;
    try {
      data = await response.json();
    } catch {
      throw safeFailure(stage, {httpStatus: response.status, reason: "invalid_json"});
    }
    const totalHeader = response.headers.get("x-wp-total");
    const pagesHeader = response.headers.get("x-wp-totalpages");
    if (!Array.isArray(data) || !/^\d+$/.test(totalHeader || "") || !/^\d+$/.test(pagesHeader || "")) {
      throw safeFailure(stage, {httpStatus: response.status, reason: "invalid_pagination"});
    }
    const total = Number(totalHeader);
    const pages = Number(pagesHeader);
    expectedTotal ??= total;
    expectedPages ??= pages;
    if (total !== expectedTotal || pages !== expectedPages || pages < 1 || pages > 30 || page > pages) {
      throw safeFailure(stage, {httpStatus: response.status, reason: "invalid_pagination"});
    }
    records.push(...data);
    if (page === pages) break;
  }
  if (records.length !== expectedTotal || new Set(records.map((record) => record?.id)).size !== records.length ||
      records.some((record) => !Number.isSafeInteger(record?.id) || record.id <= 0)) {
    throw safeFailure(stage, {reason: "incomplete_collection"});
  }
  return {records, statuses};
}

function findCategoryPair(categories, target) {
  const parentMatches = categories.filter((category) => category?.parent === 0 && normalizedText(category?.name) === normalizedText(target.parentName));
  if (parentMatches.length !== 1) throw safeFailure("category_validation", {reason: "category_mapping_failed"});
  const parent = parentMatches[0];
  const childMatches = categories.filter((category) => category?.parent === parent.id && normalizedText(category?.name) === normalizedText(target.childName));
  if (childMatches.length !== 1) throw safeFailure("category_validation", {reason: "category_mapping_failed"});
  return {parent, child: childMatches[0]};
}

export async function runSite03ImageDraftPreflight({siteBase, authorization, request = fetch, target, recoveredHistory, trialHistory, expectedCategoryIds}) {
  const base = normalizedSiteUrl(siteBase);
  if (!/^https:\/\//i.test(base) || !authorization) throw safeFailure("settings", {reason: "missing_settings"});
  if (!target?.title || target.categoryKey !== TARGET_CATEGORY_KEY || !target.parentName || target.childName !== EXPECTED_CHILD_NAME) {
    throw safeFailure("target_validation", {reason: "invalid_target"});
  }
  if (!Array.isArray(recoveredHistory) || recoveredHistory.length < 68 || !Array.isArray(trialHistory) || trialHistory.length !== 1 || trialHistory[0]?.postId !== 965) {
    throw safeFailure("history_validation", {reason: "history_invalid"});
  }
  const headers = {Authorization: authorization, Accept: "application/json"};
  const categoriesUrl = new URL(`${base}/wp-json/wp/v2/categories`);
  for (const [key, value] of Object.entries({per_page: "100", hide_empty: "false", orderby: "id", order: "asc", _fields: "id,name,parent"})) {
    categoriesUrl.searchParams.set(key, value);
  }
  const categories = await readAllPages({url: categoriesUrl, headers, request, stage: "category_get"});
  const pair = findCategoryPair(categories.records, target);
  if (expectedCategoryIds &&
      (pair.parent.id !== expectedCategoryIds.parentId || pair.child.id !== expectedCategoryIds.childId)) {
    throw safeFailure("category_validation", {reason: "category_id_mismatch"});
  }

  const postsUrl = new URL(`${base}/wp-json/wp/v2/posts`);
  for (const [key, value] of Object.entries({context: "edit", status: "draft,pending,future,publish,private,trash", per_page: "100", orderby: "id", order: "asc", _fields: "id,title,content"})) {
    postsUrl.searchParams.set(key, value);
  }
  const posts = await readAllPages({url: postsUrl, headers, request, stage: "post_get"});
  const titleKey = normalizedTitleKey(target.title);
  const duplicate = {
    wordpress: posts.records.some((post) => normalizedTitleKey(post?.title?.raw) === titleKey),
    recoveredHistory: recoveredHistory.some((record) => normalizedTitleKey(record?.title) === titleKey),
    trialHistory: trialHistory.some((record) => normalizedTitleKey(record?.title) === titleKey),
  };
  duplicate.any = duplicate.wordpress || duplicate.recoveredHistory || duplicate.trialHistory;
  const similarity = assessPlanSimilarity(target, posts.records);
  return {
    site: SITE,
    diagnosis: "완료",
    ready: !duplicate.any && !similarity.any,
    categoryHttpStatuses: categories.statuses,
    postHttpStatuses: posts.statuses,
    category: {key: target.categoryKey, parentId: pair.parent.id, childId: pair.child.id, parentChildVerified: true},
    wordpressPostCount: posts.records.length,
    recoveredHistoryCount: recoveredHistory.length,
    trialHistoryCount: trialHistory.length,
    duplicate,
    similarity,
  };
}

function targetFromCatalog() {
  const catalog = readTitleEntries(resolveTitleFile(PROJECT_ROOT, SITE));
  const parent = catalog.categories.find((category) => Number(category.number) === 4);
  const child = parent?.children?.find((category) => Number(category.number) === 3);
  if (!parent || !child || child.name !== EXPECTED_CHILD_NAME) throw safeFailure("target_validation", {reason: "invalid_target"});
  return {
    title: TARGET_TITLE,
    categoryKey: TARGET_CATEGORY_KEY,
    parentName: parent.name,
    childName: child.name,
    locations: ["칠레 산티아고", "아르헨티나 멘도사"],
  };
}

async function main() {
  const siteBase = normalizedSiteUrl(process.env.ADSENSE_SITE_03_URL);
  const user = String(process.env.ADSENSE_SITE_03_USER || "").trim();
  const password = String(process.env.ADSENSE_SITE_03_APP_PASSWORD || "").trim();
  if (!siteBase || !user || !password) throw safeFailure("settings", {reason: "missing_settings"});
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const historyRoot = join(PROGRAM_ROOT, "makeit-adsense", "inputs", "site-03");
  const result = await runSite03ImageDraftPreflight({
    siteBase,
    authorization,
    target: targetFromCatalog(),
    recoveredHistory: readRecoveredHistory(join(historyRoot, "recovered-history.json")),
    trialHistory: readTrialVerifiedHistory(join(historyRoot, "trial-verified-history.json")),
    expectedCategoryIds: {parentId: 16, childId: 19},
    request: (url, options) => fetch(url, {...options, headers: {...browserHeaders(url), ...options.headers}, signal: AbortSignal.timeout(30000)}),
  });
  console.log(JSON.stringify(result));
  if (!result.ready) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const safe = error?.safeDiagnostic || {stage: "unknown", reason: "unexpected_error"};
    console.error(JSON.stringify({site: SITE, diagnosis: "판정 불가", ready: false, ...safe}));
    process.exitCode = 1;
  });
}
