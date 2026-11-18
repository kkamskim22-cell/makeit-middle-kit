import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {createMediaIdRecorder, fetchWorkflowRuns, validateApprovedRunHistory} from "../scripts/lib/site-03-image-draft-safety.mjs";

const title = "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교";
const currentRun = {id: 500, event: "workflow_dispatch", run_attempt: 1, status: "in_progress", conclusion: null};
const failedRun = {id: 44239765345, event: "workflow_dispatch", run_attempt: 1, status: "completed", conclusion: "failure"};

function reason(expected) {
  return (error) => {
    assert.equal(error?.safeReason, expected);
    return true;
  };
}

test("기존 실패 1건과 현재 승인 실행 1건만 있을 때 통과한다", () => {
  assert.deepEqual(validateApprovedRunHistory({
    runs: [currentRun, failedRun],
    currentRunId: 500,
    currentRunAttempt: 1,
    expectedFailedRunId: 44239765345,
    targetTitle: title,
  }), {guard: "passed", currentRunId: 500, priorFailedRunId: 44239765345, approvedNewRunCount: 1});
});

test("기존 실행의 재실행 attempt 2는 차단한다", () => {
  assert.throws(() => validateApprovedRunHistory({
    runs: [{...currentRun, run_attempt: 2}, failedRun],
    currentRunId: 500,
    currentRunAttempt: 2,
    expectedFailedRunId: 44239765345,
    targetTitle: title,
  }), reason("rerun_blocked"));
});

test("승인된 신규 실행 외에 같은 워크플로 이력이 추가되면 차단한다", () => {
  assert.throws(() => validateApprovedRunHistory({
    runs: [currentRun, failedRun, {id: 499, event: "workflow_dispatch", run_attempt: 1, status: "completed", conclusion: "failure"}],
    currentRunId: 500,
    currentRunAttempt: 1,
    expectedFailedRunId: 44239765345,
    targetTitle: title,
  }), reason("unexpected_run_history"));
});

test("현재 실행 ID가 없거나 진행 중 상태가 아니면 차단한다", () => {
  assert.throws(() => validateApprovedRunHistory({
    runs: [failedRun], currentRunId: 500, currentRunAttempt: 1, expectedFailedRunId: 44239765345, targetTitle: title,
  }), reason("current_run_missing"));
  assert.throws(() => validateApprovedRunHistory({
    runs: [{...currentRun, status: "completed", conclusion: "failure"}, failedRun],
    currentRunId: 500, currentRunAttempt: 1, expectedFailedRunId: 44239765345, targetTitle: title,
  }), reason("current_run_state_invalid"));
});

test("GitHub 실행 이력 조회 실패는 재시도 없이 차단한다", async () => {
  let calls = 0;
  await assert.rejects(fetchWorkflowRuns({
    repository: "owner/repo",
    workflowFile: "site-03-image-draft-followup.yml",
    token: "test-token",
    request: async () => {
      calls += 1;
      return new Response(null, {status: 403});
    },
  }), reason("history_lookup_failed"));
  assert.equal(calls, 1);
});

test("concurrency는 동일 후속 실행의 동시 진행을 직렬화한다", () => {
  const path = fileURLToPath(new URL("../../.github/workflows/site-03-image-draft-followup.yml", import.meta.url));
  const workflow = readFileSync(path, "utf8");
  assert.match(workflow, /group:\s*site-03-image-draft-followup/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test("첫 번째 이미지 업로드 후 실패해도 대표 미디어 ID를 보존한다", () => {
  const recorder = createMediaIdRecorder();
  recorder.record({role: "featured", id: 31});
  assert.deepEqual(recorder.summary(), {uploadedMediaCount: 1, featuredMediaId: 31, inlineMediaIds: []});
});

test("두 번째 이미지 업로드 후 실패해도 대표·본문 미디어 ID를 보존한다", () => {
  const recorder = createMediaIdRecorder();
  recorder.record({role: "featured", id: 31});
  recorder.record({role: "inline", id: 32});
  assert.deepEqual(recorder.summary(), {uploadedMediaCount: 2, featuredMediaId: 31, inlineMediaIds: [32]});
});

test("세 번째 이미지 업로드 후 실패해도 세 미디어 ID를 보존한다", () => {
  const recorder = createMediaIdRecorder();
  recorder.record({role: "featured", id: 31});
  recorder.record({role: "inline", id: 32});
  recorder.record({role: "inline", id: 33});
  assert.deepEqual(recorder.summary(), {uploadedMediaCount: 3, featuredMediaId: 31, inlineMediaIds: [32, 33]});
});

test("정상 완료는 대표 1개와 본문 2개만 허용한다", () => {
  const recorder = createMediaIdRecorder();
  recorder.record({role: "featured", id: 31});
  recorder.record({role: "inline", id: 32});
  recorder.record({role: "inline", id: 33});
  assert.deepEqual(recorder.assertComplete(), {uploadedMediaCount: 3, featuredMediaId: 31, inlineMediaIds: [32, 33]});
  assert.throws(() => recorder.record({role: "inline", id: 34}), reason("media_limit_exceeded"));
});

test("미디어 기록이 3개 미만이면 WordPress 글 생성 전 검증에서 차단한다", () => {
  const recorder = createMediaIdRecorder();
  recorder.record({role: "featured", id: 31});
  recorder.record({role: "inline", id: 32});
  assert.throws(() => recorder.assertComplete(), reason("media_record_incomplete"));
});
