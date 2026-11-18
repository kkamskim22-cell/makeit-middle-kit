#!/usr/bin/env node

import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {browserHeaders} from "./lib/wp.mjs";
import {loadEnv} from "./lib/env.mjs";
import {readRecoveredHistory, verifyRecoveredHistory} from "./lib/site-03-recovered-history.mjs";

function siteUrl(value) {
  const raw = String(value || "").trim().replace(/^['"]+|['"]+$/g, "");
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
}

async function main(env = loadEnv()) {
  const url = siteUrl(env.ADSENSE_SITE_03_URL);
  const user = String(env.ADSENSE_SITE_03_USER || "").trim();
  const password = String(env.ADSENSE_SITE_03_APP_PASSWORD || "").trim();
  if (!url || !user || !password) return {site: 3, diagnosis: "판정 불가", requestCount: 0};
  const records = readRecoveredHistory(join(dirname(fileURLToPath(import.meta.url)), "..", "makeit-adsense", "inputs", "site-03", "recovered-history.json"));
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const result = await verifyRecoveredHistory({
    siteBase: url,
    headers: {Authorization: authorization, Accept: "application/json"},
    records,
    request: (target, options) => fetch(target, {
      ...options,
      headers: {...browserHeaders(target), ...options.headers},
      signal: AbortSignal.timeout(30000),
    }),
  });
  return {
    site: 3,
    diagnosis: "완료",
    requestCount: records.length,
    verifiedCount: result.verifiedCount,
    changedCount: result.changedPostIds.length,
    deletedCount: result.deletedPostIds.length,
    inaccessibleCount: result.inaccessiblePostIds.length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((result) => console.log(JSON.stringify(result))).catch(() => console.log(JSON.stringify({site: 3, diagnosis: "판정 불가", requestCount: 0})));
}

export {main as runRecoveredHistoryVerification};
