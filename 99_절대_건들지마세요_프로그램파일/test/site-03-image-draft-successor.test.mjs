import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {validateApprovedSuccessorRunHistory} from "../scripts/lib/site-03-image-draft-safety.mjs";

const title = "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교";
const expectedFailedRunIds = [44239765345, 44269331092];
const priorRuns = expectedFailedRunIds.map((id) => ({
  id,
  event: "workflow_dispatch",
  run_attempt: 1,
  status: "completed",
  conclusion: "failure",
}));
const currentRun = {id: 600, event: "workflow_dispatch", run_attempt: 1, status: "in_progress", conclusion: null};

function reason(expected) {
  return (error) => {
    assert.equal(error?.safeReason, expected);
    return true;
  };
}

function validate(overrides = {}) {
  return validateApprovedSuccessorRunHistory({
    priorRuns,
    successorRuns: [currentRun],
    currentRunId: 600,
    currentRunAttempt: 1,
    expectedFailedRunIds,
    targetTitle: title,
    ...overrides,
  });
}

test("기존 실패 2건과 현재 신규 실행 1건만 있으면 통과한다", () => {
  assert.deepEqual(validate(), {
    guard: "passed",
    currentRunId: 600,
    priorFailedRunIds: expectedFailedRunIds,
    approvedNewRunCount: 1,
  });
});

test("신규 실행의 재실행 attempt 2를 차단한다", () => {
  assert.throws(() => validate({
    successorRuns: [{...currentRun, run_attempt: 2}],
    currentRunAttempt: 2,
  }), reason("rerun_blocked"));
});

test("기존 실패 이력이 누락·변경·추가되면 차단한다", () => {
  assert.throws(() => validate({priorRuns: priorRuns.slice(0, 1)}), reason("unexpected_prior_history"));
  assert.throws(() => validate({priorRuns: [{...priorRuns[0], conclusion: "success"}, priorRuns[1]]}), reason("unexpected_prior_history"));
  assert.throws(() => validate({priorRuns: [...priorRuns, {...priorRuns[0], id: 1}]}), reason("unexpected_prior_history"));
});

test("승인된 현재 실행 외에 신규 워크플로 이력이 있으면 차단한다", () => {
  assert.throws(() => validate({
    successorRuns: [currentRun, {id: 599, event: "workflow_dispatch", run_attempt: 1, status: "completed", conclusion: "failure"}],
  }), reason("unexpected_run_history"));
});

test("현재 실행 ID가 없거나 진행 중이 아니면 차단한다", () => {
  assert.throws(() => validate({successorRuns: []}), reason("current_run_missing"));
  assert.throws(() => validate({
    successorRuns: [{...currentRun, status: "completed", conclusion: "failure"}],
  }), reason("current_run_state_invalid"));
});

test("신규 워크플로는 읽기 권한·동시 실행 차단·가드 선행 순서를 고정한다", () => {
  const path = fileURLToPath(new URL("../../.github/workflows/site-03-image-draft-successor.yml", import.meta.url));
  const workflow = readFileSync(path, "utf8");
  assert.match(workflow, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bschedule:|\bworkflow_call:/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read\s*\n\s+actions:\s*read/);
  assert.match(workflow, /group:\s*site-03-image-draft-followup/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.match(workflow, /site-03-image-draft-successor-run-guard\.mjs/);
  assert.match(workflow, /site-03-image-draft-successor\.mjs/);
  assert.ok(workflow.indexOf("site-03-image-draft-successor-run-guard.mjs") < workflow.indexOf("site-03-image-draft-successor.mjs"));
  assert.match(workflow, /if:\s*always\(\)/);
});
