import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {buildCategoryProbe, buildPostListProbes, runRest403Diagnostic} from "../scripts/site-03-rest-403-diagnostic.mjs";

test("실패 실행과 같은 목록 경로를 기본·rest_route 경로 및 두 필드 조합으로 만든다", () => {
  const probes = buildPostListProbes("https://example.test");
  assert.equal(probes.length, 4);
  assert.deepEqual(
    probes.map((probe) => [probe.route, probe.fields, new URL(probe.url).pathname, new URL(probe.url).searchParams.get("rest_route")]),
    [
      ["wp-json", "title", "/wp-json/wp/v2/posts", null],
      ["rest_route", "title", "/", "/wp/v2/posts"],
      ["wp-json", "title,date_gmt,status", "/wp-json/wp/v2/posts", null],
      ["rest_route", "title,date_gmt,status", "/", "/wp/v2/posts"],
    ],
  );
  for (const probe of probes) {
    const query = new URL(probe.url).searchParams;
    assert.equal(query.get("context"), "edit");
    assert.equal(query.get("status"), "draft,pending,future,publish,private");
    assert.equal(query.get("per_page"), "100");
    assert.equal(query.get("page"), "1");
    assert.equal(query.get("orderby"), "id");
    assert.equal(query.get("order"), "asc");
  }
});

test("카테고리 목록을 읽기 전용 GET 경로로 만든다", () => {
  const probe = buildCategoryProbe("https://example.test");
  const url = new URL(probe.url);
  assert.equal(probe.route, "wp-json");
  assert.equal(probe.resource, "categories");
  assert.equal(probe.fields, "id,name,parent");
  assert.equal(url.pathname, "/wp-json/wp/v2/categories");
  assert.equal(url.searchParams.get("per_page"), "100");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("hide_empty"), "false");
  assert.equal(url.searchParams.get("orderby"), "id");
  assert.equal(url.searchParams.get("order"), "asc");
});

test("모의 403 응답은 오류 코드와 안전한 차단 징후만 집계하고 본문·인증값을 남기지 않는다", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url, options});
    if (url.startsWith("https://api.ipify.org")) {
      return new Response(JSON.stringify({ip: "3.41.210.120"}), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }
    if (url.includes("users/me")) {
      return new Response(JSON.stringify({id: 3, capabilities: {edit_posts: true}}), {
        status: 200,
        headers: {"content-type": "application/json"},
      });
    }
    if (url.includes("rest_route")) {
      return new Response("<html>captcha</html>", {
        status: 403,
        headers: {"content-type": "text/html; charset=utf-8", server: "cloudways"},
      });
    }
    return new Response(JSON.stringify({code: "rest_forbidden", message: "민감한 응답 본문"}), {
      status: 403,
      headers: {"content-type": "application/json"},
    });
  };

  const result = await runRest403Diagnostic({
    siteUrl: "https://example.test",
    authorization: "Basic test-only-secret",
    fetchFn: fakeFetch,
  });

  assert.equal(calls.length, 7);
  assert.equal(calls.every((call) => call.options.method === "GET"), true);
  assert.deepEqual(result.permission, {userContextEdit: true, editPosts: true});
  assert.deepEqual(result.runner, {
    lookupHttpStatus: 200,
    externalIp: "3.41.210.120",
    matchesPastBlockedIp: true,
  });
  assert.equal(result.probes.length, 5);
  assert.equal(result.probes.filter((probe) => probe.httpStatus === 403).length, 5);
  assert.equal(result.probes.find((probe) => probe.resource === "categories")?.httpStatus, 403);
  assert.equal(result.requestCount, 7);
  assert.equal(result.probes.some((probe) => probe.wordpressErrorCode === "rest_forbidden"), true);
  assert.equal(result.probes.some((probe) => probe.waf.cloudwaysHeaderDetected), true);
  assert.equal(result.probes.some((probe) => probe.waf.htmlChallengeDetected), true);
  const output = JSON.stringify(result);
  assert.equal(output.includes("민감한 응답 본문"), false);
  assert.equal(output.includes("test-only-secret"), false);
  assert.equal(output.includes("Authorization"), false);
});

test("WordPress 요청 중 네트워크 예외가 나도 시도한 요청 수를 정확히 보고한다", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url, options});
    if (url.startsWith("https://api.ipify.org")) return new Response(JSON.stringify({ip: "1.2.3.4"}), {status: 200});
    if (url.includes("users/me")) return new Response(JSON.stringify({id: 3, capabilities: {edit_posts: true}}), {status: 200});
    throw new Error("simulated network failure");
  };

  const result = await runRest403Diagnostic({
    siteUrl: "https://example.test",
    authorization: "Basic test-only-secret",
    fetchFn: fakeFetch,
  });

  assert.equal(calls.length, 3);
  assert.equal(result.requestCount, calls.length);
  assert.equal(result.diagnosis, "판정 불가");
});

test("Runner IP 조회에는 제한 시간 중단 신호를 사용한다", async () => {
  let ipSignal = null;
  const fakeFetch = async (url, options) => {
    if (url.startsWith("https://api.ipify.org")) {
      ipSignal = options.signal;
      return new Response(JSON.stringify({ip: "1.2.3.4"}), {status: 200});
    }
    if (url.includes("users/me")) return new Response(JSON.stringify({id: 3, capabilities: {edit_posts: true}}), {status: 200});
    return new Response("[]", {status: 200, headers: {"content-type": "application/json"}});
  };

  const result = await runRest403Diagnostic({
    siteUrl: "https://example.test",
    authorization: "Basic test-only-secret",
    fetchFn: fakeFetch,
  });

  assert.equal(ipSignal instanceof AbortSignal, true);
  assert.equal(result.runner.externalIp, "1.2.3.4");
  assert.equal(result.runner.matchesPastBlockedIp, false);
});

test("Runner IP를 확인하지 못하면 WordPress GET 성공과 별개로 판정 불가를 보고한다", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url, options});
    if (url.startsWith("https://api.ipify.org")) throw new Error("simulated IP lookup failure");
    if (url.includes("users/me")) return new Response(JSON.stringify({id: 3, capabilities: {edit_posts: true}}), {status: 200});
    return new Response("[]", {status: 200, headers: {"content-type": "application/json"}});
  };

  const result = await runRest403Diagnostic({
    siteUrl: "https://example.test",
    authorization: "Basic test-only-secret",
    fetchFn: fakeFetch,
  });

  assert.deepEqual(result.runner, {lookupHttpStatus: null, externalIp: null, matchesPastBlockedIp: null});
  assert.equal(result.probes.every((probe) => probe.httpStatus === 200), true);
  assert.equal(result.requestCount, 7);
  assert.equal(result.diagnosis, "판정 불가");
});

test("한글 경로에서도 직접 실행 시 안전한 판정 불가 요약을 출력한다", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/site-03-rest-403-diagnostic.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], {encoding: "utf8", env: {}});
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    site: 3,
    diagnosis: "판정 불가",
    permission: {userContextEdit: false, editPosts: null},
    probes: [],
    requestCount: 0,
  });
});
