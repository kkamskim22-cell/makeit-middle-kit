#!/usr/bin/env node

import {browserHeaders, isCloudflare, looksLikeChallenge, toRestRouteUrl} from "./lib/wp.mjs";
import {fileURLToPath} from "node:url";
import {isIP} from "node:net";

const SITE = 3;
const PAST_BLOCKED_RUNNER_IP = "3.41.210.120";
const RUNNER_IP_URL = "https://api.ipify.org?format=json";
const POST_LIST_QUERY = {
  context: "edit",
  status: "draft,pending,future,publish,private",
  per_page: "100",
  page: "1",
  orderby: "id",
  order: "asc",
};

function normalizedSiteUrl(value) {
  const raw = String(value || "").trim().replace(/^['"]+|['"]+$/g, "");
  if (!raw) return "";
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
}

function safeContentType(response) {
  return String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() || null;
}

function safeWordPressErrorCode(body, contentType) {
  if (contentType !== "application/json") return null;
  try {
    const code = JSON.parse(body)?.code;
    return typeof code === "string" && /^[a-z0-9_-]{1,80}$/i.test(code) ? code : null;
  } catch {
    return null;
  }
}

function safeWafSignals(response, body) {
  const server = String(response.headers.get("server") || "");
  return {
    blockingStatus: [403, 429, 503].includes(response.status),
    htmlChallengeDetected: looksLikeChallenge(body),
    cloudflareHeaderDetected: isCloudflare(response),
    cloudwaysHeaderDetected: /cloudways/i.test(server),
  };
}

export function buildPostListProbes(siteUrl) {
  const base = normalizedSiteUrl(siteUrl);
  const fields = ["title", "title,date_gmt,status"];
  return fields.flatMap((fieldSet) => {
    const direct = new URL(`${base}/wp-json/wp/v2/posts`);
    for (const [key, value] of Object.entries({...POST_LIST_QUERY, _fields: fieldSet})) direct.searchParams.set(key, value);
    const alternate = toRestRouteUrl(direct.toString());
    return [
      {route: "wp-json", resource: "posts", fields: fieldSet, url: direct.toString()},
      {route: "rest_route", resource: "posts", fields: fieldSet, url: alternate},
    ];
  });
}

export function buildCategoryProbe(siteUrl) {
  const url = new URL(`${normalizedSiteUrl(siteUrl)}/wp-json/wp/v2/categories`);
  for (const [key, value] of Object.entries({
    per_page: "100",
    page: "1",
    hide_empty: "false",
    orderby: "id",
    order: "asc",
    _fields: "id,name,parent",
  })) url.searchParams.set(key, value);
  return {route: "wp-json", resource: "categories", fields: "id,name,parent", url: url.toString()};
}

async function inspectResponse({route, resource, fields, url}, authorization, fetchFn) {
  const response = await fetchFn(url, {
    method: "GET",
    headers: {...browserHeaders(url), Authorization: authorization, Accept: "application/json"},
  });
  const contentType = safeContentType(response);
  // 성공 응답에는 제목이 포함될 수 있으므로 읽지 않는다. 실패 본문도 메모리에서만 분류한다.
  const body = response.ok ? "" : await response.text();
  return {
    route,
    resource,
    fields,
    httpStatus: response.status,
    contentType,
    wordpressErrorCode: safeWordPressErrorCode(body, contentType),
    waf: safeWafSignals(response, body),
  };
}

async function inspectRunnerIp(fetchFn) {
  try {
    const response = await fetchFn(RUNNER_IP_URL, {
      method: "GET",
      headers: {Accept: "application/json"},
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return {lookupHttpStatus: response.status, externalIp: null, matchesPastBlockedIp: null};
    const data = await response.json();
    const externalIp = String(data?.ip || "").trim();
    if (!isIP(externalIp)) return {lookupHttpStatus: response.status, externalIp: null, matchesPastBlockedIp: null};
    return {
      lookupHttpStatus: response.status,
      externalIp,
      matchesPastBlockedIp: externalIp === PAST_BLOCKED_RUNNER_IP,
    };
  } catch {
    return {lookupHttpStatus: null, externalIp: null, matchesPastBlockedIp: null};
  }
}

async function inspectPermission(siteUrl, authorization, fetchFn) {
  const url = `${normalizedSiteUrl(siteUrl)}/wp-json/wp/v2/users/me?context=edit&_fields=id,capabilities`;
  const response = await fetchFn(url, {
    method: "GET",
    headers: {...browserHeaders(url), Authorization: authorization, Accept: "application/json"},
  });
  if (!response.ok) return {userContextEdit: false, editPosts: null};
  try {
    const data = await response.json();
    const capability = data?.capabilities?.edit_posts;
    return {userContextEdit: Boolean(data?.id), editPosts: typeof capability === "boolean" ? capability : null};
  } catch {
    return {userContextEdit: false, editPosts: null};
  }
}

export async function runRest403Diagnostic({siteUrl, authorization, fetchFn = fetch}) {
  const probes = [];
  let permission = {userContextEdit: false, editPosts: null};
  let requestCount = 0;
  const countedFetch = (...args) => {
    requestCount += 1;
    return fetchFn(...args);
  };
  const runner = await inspectRunnerIp(countedFetch);
  try {
    permission = await inspectPermission(siteUrl, authorization, countedFetch);
    for (const probe of buildPostListProbes(siteUrl)) probes.push(await inspectResponse(probe, authorization, countedFetch));
    probes.push(await inspectResponse(buildCategoryProbe(siteUrl), authorization, countedFetch));
  } catch {
    return {site: SITE, runner, permission, probes, diagnosis: "판정 불가", requestCount};
  }
  const diagnosis = runner.externalIp ? "완료" : "판정 불가";
  return {site: SITE, runner, permission, probes, diagnosis, requestCount};
}

async function main() {
  const siteUrl = normalizedSiteUrl(process.env.ADSENSE_SITE_03_URL);
  const user = String(process.env.ADSENSE_SITE_03_USER || "").trim();
  const password = String(process.env.ADSENSE_SITE_03_APP_PASSWORD || "").trim();
  if (!siteUrl || !user || !password) {
    console.log(JSON.stringify({site: SITE, diagnosis: "판정 불가", permission: {userContextEdit: false, editPosts: null}, probes: [], requestCount: 0}));
    return;
  }
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  console.log(JSON.stringify(await runRest403Diagnostic({siteUrl, authorization})));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
