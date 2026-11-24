import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {validateApprovedFinalRunHistory} from "../scripts/lib/site-03-image-draft-safety.mjs";

const title = "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교";
const priorRun = {id: 45140307993, event: "workflow_dispatch", run_attempt: 1, status: "completed", conclusion: "failure"};
const currentRun = {id: 800, event: "workflow_dispatch", run_attempt: 1, status: "in_progress", conclusion: null};

function validate(overrides = {}) {
  return validateApprovedFinalRunHistory({
    priorRuns: [priorRun],
    finalRuns: [currentRun],
    currentRunId: 800,
    currentRunAttempt: 1,
    expectedPriorFailedRunId: 45140307993,
    targetTitle: title,
    ...overrides,
  });
}

test("1,479자 실패 실행 1건과 현재 1,300자 경로 최초 실행만 허용한다", () => {
  assert.deepEqual(validate(), {
    guard: "passed",
    currentRunId: 800,
    priorFailedRunId: 45140307993,
    approvedNewRunCount: 1,
  });
  assert.throws(() => validate({priorRuns: [{...priorRun, id: 45138529004}]}), (error) => error?.safeReason === "unexpected_prior_history");
  assert.throws(() => validate({finalRuns: [currentRun, {...currentRun, id: 799}]}), (error) => error?.safeReason === "unexpected_run_history");
  assert.throws(() => validate({currentRunAttempt: 2}), (error) => error?.safeReason === "rerun_blocked");
});

test("1,300자 경로는 새 가드와 읽기 전용 사전검사 후 고정 카테고리로 한 번만 생성한다", () => {
  const path = fileURLToPath(new URL("../../.github/workflows/site-03-image-draft-1300.yml", import.meta.url));
  const workflow = readFileSync(path, "utf8");
  assert.match(workflow, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bschedule:|\bworkflow_call:|\$\{\{\s*inputs\./);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read\s*\n\s+actions:\s*read/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.match(workflow, /site-03-image-draft-1300-run-guard\.mjs/);
  assert.match(workflow, /site-03-image-draft-preflight\.mjs/);
  assert.match(workflow, /site-03-image-draft-1300\.mjs --parent-category-id=16 --child-category-id=19/);
  assert.match(workflow, /api\.ipify\.org/);
  assert.ok(workflow.indexOf("site-03-image-draft-1300-run-guard.mjs") < workflow.indexOf("site-03-image-draft-preflight.mjs"));
  assert.ok(workflow.indexOf("site-03-image-draft-preflight.mjs") < workflow.indexOf("site-03-image-draft-1300.mjs"));
  assert.match(workflow, /if:\s*always\(\)/);
});
