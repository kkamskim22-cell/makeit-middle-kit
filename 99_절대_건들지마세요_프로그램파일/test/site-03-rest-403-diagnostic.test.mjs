import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {buildPostListProbes, runRest403Diagnostic} from "../scripts/site-03-rest-403-diagnostic.mjs";

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

test("모의 403 응답은 오류 코드와 안전한 차단 징후만 집계하고 본문·인증값을 남기지 않는다", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({url, options});
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

  assert.equal(calls.length, 5);
  assert.equal(calls.every((call) => call.options.method === "GET"), true);
  assert.deepEqual(result.permission, {userContextEdit: true, editPosts: true});
  assert.equal(result.probes.length, 4);
  assert.equal(result.probes.filter((probe) => probe.httpStatus === 403).length, 4);
  assert.equal(result.probes.some((probe) => probe.wordpressErrorCode === "rest_forbidden"), true);
  assert.equal(result.probes.some((probe) => probe.waf.cloudwaysHeaderDetected), true);
  assert.equal(result.probes.some((probe) => probe.waf.htmlChallengeDetected), true);
  const output = JSON.stringify(result);
  assert.equal(output.includes("민감한 응답 본문"), false);
  assert.equal(output.includes("test-only-secret"), false);
  assert.equal(output.includes("Authorization"), false);
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
