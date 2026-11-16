#!/usr/bin/env node

import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {readTitleEntries, resolveTitleFile} from "./title-files.mjs";
import {wpFetch} from "./lib/wp.mjs";

const SITE = 3;
const POST_IDS = [874, 876, 878];
const programRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = String(process.env.MAKEIT_PROJECT_ROOT || "").trim() || dirname(programRoot);

export function titleKey(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function compareTitles(titleEntries, wordpressTitles) {
  const wordpressKeys = new Set(wordpressTitles.map(titleKey).filter(Boolean));
  const matchingCount = new Set(titleEntries.map((entry) => titleKey(typeof entry === "string" ? entry : entry?.title)).filter((key) => wordpressKeys.has(key))).size;
  return {risk: matchingCount > 0 ? "감지됨" : "없음", matchingCount};
}

export function safePostSummary(id, httpStatus, post) {
  return {
    id,
    exists: httpStatus === 200 && Number(post?.id) === Number(id),
    postStatus: httpStatus === 200 && typeof post?.status === "string" ? post.status : null,
    httpStatus,
  };
}

export function shouldRecommendResume(cloudwaysBlocked, duplicateRisk, posts) {
  return !cloudwaysBlocked && duplicateRisk === "없음" && posts.every((post) => post.exists);
}

function baseUrl(value) {
  const raw = String(value || "").trim().replace(/^["']+|["']+$/g, "");
  if (!raw) return "";
  return ( /^https?:\/\//i.test(raw) ? raw : `https://${raw}` ).replace(/\/+$/, "");
}

function credentials(user, password) {
  return Buffer.from(`${String(user || "").trim()}:${String(password || "").trim()}`).toString("base64");
}

async function getJson(url, authorization) {
  const response = await wpFetch(url, {
    method: "GET",
    headers: {Authorization: `Basic ${authorization}`, Accept: "application/json"},
  });
  const httpStatus = response.status;
  let data = null;
  try {
    data = await response.json();
  } catch {
    // 응답 본문은 출력하지 않는다. HTML 차단 페이지도 여기서 안전하게 처리한다.
  }
  return {httpStatus, data, blocked: Boolean(response.blocked || response.challenged)};
}

async function fetchAllTitles(url, authorization) {
  const titles = [];
  for (let page = 1; page <= 30; page += 1) {
    const result = await getJson(
      `${url}/wp-json/wp/v2/posts?context=edit&status=draft,pending,future,publish,private&per_page=100&page=${page}&orderby=id&order=asc&_fields=title`,
      authorization,
    );
    // 마지막 페이지 다음의 400은 WordPress REST API의 정상 종료 신호다.
    if (result.httpStatus === 400) return {ok: true, titles, blocked: result.blocked};
    if (result.httpStatus !== 200 || !Array.isArray(result.data)) return {ok: false, titles: [], blocked: result.blocked};
    for (const post of result.data) {
      const title = String(post?.title?.raw || post?.title?.rendered || "").trim();
      if (title) titles.push(title);
    }
    if (result.data.length < 100) return {ok: true, titles, blocked: result.blocked};
  }
  return {ok: false, titles: [], blocked: false};
}

function failureSummary(connectionHttpStatus = null, posts = []) {
  return {
    site: SITE,
    connection: "실패",
    connectionHttpStatus,
    cloudwaysBlockDetected: null,
    posts,
    duplicateRisk: "판정 불가",
    automationResumeRecommended: false,
  };
}

export async function runDiagnostic(env = process.env) {
  const url = baseUrl(env.ADSENSE_SITE_03_URL);
  const user = String(env.ADSENSE_SITE_03_USER || "").trim();
  const password = String(env.ADSENSE_SITE_03_APP_PASSWORD || "").trim();
  if (!url || !user || !password) return failureSummary();

  const authorization = credentials(user, password);
  let connection;
  try {
    connection = await getJson(`${url}/wp-json/wp/v2/users/me?context=edit&_fields=id`, authorization);
  } catch {
    return failureSummary();
  }
  if (connection.httpStatus !== 200 || !connection.data) return failureSummary(connection.httpStatus);

  const posts = [];
  let blocked = connection.blocked;
  try {
    for (const id of POST_IDS) {
      const result = await getJson(`${url}/wp-json/wp/v2/posts/${id}?context=edit&_fields=id,title,status`, authorization);
      blocked ||= result.blocked;
      posts.push(safePostSummary(id, result.httpStatus, result.data));
      if (result.httpStatus !== 200 && result.httpStatus !== 404) return failureSummary(connection.httpStatus, posts);
    }

    const wordpress = await fetchAllTitles(url, authorization);
    blocked ||= wordpress.blocked;
    if (!wordpress.ok) return failureSummary(connection.httpStatus, posts);

    const titleCatalog = readTitleEntries(resolveTitleFile(projectRoot, SITE));
    const comparison = compareTitles(titleCatalog.entries, wordpress.titles);
    return {
      site: SITE,
      connection: "성공",
      connectionHttpStatus: connection.httpStatus,
      cloudwaysBlockDetected: blocked,
      posts,
      duplicateRisk: comparison.risk,
      automationResumeRecommended: shouldRecommendResume(blocked, comparison.risk, posts),
    };
  } catch {
    return failureSummary(connection.httpStatus, posts);
  }
}

async function main() {
  const summary = await runDiagnostic();
  console.log(JSON.stringify(summary));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => console.log(JSON.stringify(failureSummary())));
}
