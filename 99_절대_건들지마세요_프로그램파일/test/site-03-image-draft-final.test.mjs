import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createServer} from "node:http";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {validateApprovedFinalRunHistory} from "../scripts/lib/site-03-image-draft-safety.mjs";
import {postDraftOnce, validateRequiredCategoryIds} from "../scripts/site-03-image-draft-followup.mjs";

const title = "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교";
const priorRun = {
  id: 45138529004,
  event: "workflow_dispatch",
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
};
const currentRun = {id: 700, event: "workflow_dispatch", run_attempt: 1, status: "in_progress", conclusion: null};

function reason(expected) {
  return (error) => {
    assert.equal(error?.safeReason, expected);
    return true;
  };
}

function validate(overrides = {}) {
  return validateApprovedFinalRunHistory({
    priorRuns: [priorRun],
    finalRuns: [currentRun],
    currentRunId: 700,
    currentRunAttempt: 1,
    expectedPriorFailedRunId: 45138529004,
    targetTitle: title,
    ...overrides,
  });
}

test("본문 분량 미달 실패 1건과 현재 최종 실행 1건만 통과한다", () => {
  assert.deepEqual(validate(), {
    guard: "passed",
    currentRunId: 700,
    priorFailedRunId: 45138529004,
    approvedNewRunCount: 1,
  });
});

test("이전 실패 실행의 재실행이나 새 최종 실행의 재실행을 차단한다", () => {
  assert.throws(() => validate({priorRuns: [{...priorRun, run_attempt: 2}]}), reason("unexpected_prior_history"));
  assert.throws(() => validate({finalRuns: [{...currentRun, run_attempt: 2}], currentRunAttempt: 2}), reason("rerun_blocked"));
});

test("승인된 실패 실행 외의 이력 또는 최종 실행 추가 이력을 차단한다", () => {
  assert.throws(() => validate({priorRuns: []}), reason("unexpected_prior_history"));
  assert.throws(() => validate({priorRuns: [{...priorRun, conclusion: "success"}]}), reason("unexpected_prior_history"));
  assert.throws(() => validate({finalRuns: [currentRun, {...currentRun, id: 699, status: "completed", conclusion: "failure"}]}), reason("unexpected_run_history"));
});

test("최종 워크플로는 새 가드와 사전검사를 생성보다 먼저 실행한다", () => {
  const path = fileURLToPath(new URL("../../.github/workflows/site-03-image-draft-final.yml", import.meta.url));
  const workflow = readFileSync(path, "utf8");
  assert.match(workflow, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bschedule:|\bworkflow_call:/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read\s*\n\s+actions:\s*read/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.doesNotMatch(workflow, /\$\{\{\s*inputs\./);
  assert.match(workflow, /site-03-image-draft-final\.mjs --parent-category-id=16 --child-category-id=19/);
  assert.match(workflow, /site-03-image-draft-final-run-guard\.mjs/);
  assert.match(workflow, /site-03-image-draft-preflight\.mjs/);
  assert.match(workflow, /site-03-image-draft-final\.mjs/);
  assert.match(workflow, /api\.ipify\.org/);
  assert.ok(workflow.indexOf("site-03-image-draft-final-run-guard.mjs") < workflow.indexOf("site-03-image-draft-preflight.mjs"));
  assert.ok(workflow.indexOf("site-03-image-draft-preflight.mjs") < workflow.indexOf("site-03-image-draft-final.mjs"));
  assert.match(workflow, /if:\s*always\(\)/);
});

test("최종 경로는 사전 확인한 4-3 카테고리 ID 16과 19만 허용한다", () => {
  assert.deepEqual(validateRequiredCategoryIds({
    parentId: 16,
    childId: 19,
    expectedCategoryIds: {parentId: 16, childId: 19},
  }), {parentId: 16, childId: 19});
  assert.throws(() => validateRequiredCategoryIds({
    parentId: 4,
    childId: 7,
    expectedCategoryIds: {parentId: 16, childId: 19},
  }), /카테고리 ID/);
});

test("글 생성 POST는 307 리디렉션을 따라가 두 번째 요청을 보내지 않는다", async () => {
  let redirectedPostCount = 0;
  const target = createServer((request, response) => {
    if (request.method === "POST") redirectedPostCount += 1;
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end('{"id":999}');
  });
  const redirect = createServer((_request, response) => {
    const address = target.address();
    response.writeHead(307, {Location: `http://127.0.0.1:${address.port}/target`});
    response.end();
  });
  await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => redirect.listen(0, "127.0.0.1", resolve));
  try {
    const address = redirect.address();
    await assert.rejects(postDraftOnce({
      url: `http://127.0.0.1:${address.port}/create`,
      headers: {"Content-Type": "application/json"},
      payload: {status: "draft"},
    }));
    assert.equal(redirectedPostCount, 0);
  } finally {
    await new Promise((resolve) => redirect.close(resolve));
    await new Promise((resolve) => target.close(resolve));
  }
});
