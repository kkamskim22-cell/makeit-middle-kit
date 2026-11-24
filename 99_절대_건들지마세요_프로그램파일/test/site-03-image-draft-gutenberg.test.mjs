import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {validateApprovedFinalRunHistory} from "../scripts/lib/site-03-image-draft-safety.mjs";

const title = "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교";
const priorRun = {id: 45337375552, event: "workflow_dispatch", run_attempt: 1, status: "completed", conclusion: "failure"};
const currentRun = {id: 900, event: "workflow_dispatch", run_attempt: 1, status: "in_progress", conclusion: null};

function validate(overrides = {}) {
  return validateApprovedFinalRunHistory({
    priorRuns: [priorRun],
    finalRuns: [currentRun],
    currentRunId: 900,
    currentRunAttempt: 1,
    expectedPriorFailedRunId: 45337375552,
    targetTitle: title,
    ...overrides,
  });
}

test("Gutenberg 형식 실패 1건과 현재 신규 경로 최초 실행만 허용한다", () => {
  assert.deepEqual(validate(), {
    guard: "passed",
    currentRunId: 900,
    priorFailedRunId: 45337375552,
    approvedNewRunCount: 1,
  });
  assert.throws(() => validate({priorRuns: [{...priorRun, id: 45140307993}]}), (error) => error?.safeReason === "unexpected_prior_history");
  assert.throws(() => validate({finalRuns: [currentRun, {...currentRun, id: 899}]}), (error) => error?.safeReason === "unexpected_run_history");
  assert.throws(() => validate({currentRunAttempt: 2}), (error) => error?.safeReason === "rerun_blocked");
});

test("Gutenberg 보완 경로는 새 가드와 사전검사 후 고정 카테고리로 한 번만 생성한다", () => {
  const path = fileURLToPath(new URL("../../.github/workflows/site-03-image-draft-gutenberg.yml", import.meta.url));
  const workflow = readFileSync(path, "utf8");
  assert.match(workflow, /on:\s*\n\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bschedule:|\bworkflow_call:|\$\{\{\s*inputs\./);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read\s*\n\s+actions:\s*read/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.match(workflow, /site-03-image-draft-gutenberg-run-guard\.mjs/);
  assert.match(workflow, /site-03-image-draft-preflight\.mjs/);
  assert.match(workflow, /site-03-image-draft-gutenberg\.mjs --parent-category-id=16 --child-category-id=19/);
  assert.match(workflow, /api\.ipify\.org/);
  assert.ok(workflow.indexOf("site-03-image-draft-gutenberg-run-guard.mjs") < workflow.indexOf("site-03-image-draft-preflight.mjs"));
  assert.ok(workflow.indexOf("site-03-image-draft-preflight.mjs") < workflow.indexOf("site-03-image-draft-gutenberg.mjs"));
  assert.match(workflow, /if:\s*always\(\)/);
});
