const APPROVED_TITLE = "산맥을 사이에 둔 두 세계 여행지의 계절 기후 비교";

function safetyFailure(reason) {
  const error = new Error(reason);
  error.safeReason = reason;
  return error;
}

export function validateApprovedRunHistory({runs, currentRunId, currentRunAttempt, expectedFailedRunId, targetTitle}) {
  if (targetTitle !== APPROVED_TITLE) throw safetyFailure("target_title_mismatch");
  if (currentRunAttempt !== 1) throw safetyFailure("rerun_blocked");
  if (!Array.isArray(runs)) throw safetyFailure("history_lookup_failed");
  const currentMatches = runs.filter((run) => run?.id === currentRunId);
  if (currentMatches.length !== 1) throw safetyFailure("current_run_missing");
  const current = currentMatches[0];
  if (current.event !== "workflow_dispatch" || current.run_attempt !== 1 || current.status !== "in_progress" || current.conclusion !== null) {
    throw safetyFailure("current_run_state_invalid");
  }
  const prior = runs.filter((run) => run?.id !== currentRunId);
  if (runs.length !== 2 || prior.length !== 1) throw safetyFailure("unexpected_run_history");
  const failed = prior[0];
  if (failed.id !== expectedFailedRunId || failed.event !== "workflow_dispatch" || failed.run_attempt !== 1 ||
      failed.status !== "completed" || failed.conclusion !== "failure") {
    throw safetyFailure("unexpected_run_history");
  }
  return {guard: "passed", currentRunId, priorFailedRunId: failed.id, approvedNewRunCount: 1};
}

export async function fetchWorkflowRuns({repository, workflowFile, token, request = fetch}) {
  if (!repository || !workflowFile || !token) throw safetyFailure("history_lookup_failed");
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=workflow_dispatch&per_page=100`;
  let response;
  try {
    response = await request(url, {
      method: "GET",
      headers: {Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
    });
  } catch {
    throw safetyFailure("history_lookup_failed");
  }
  if (response.status !== 200) throw safetyFailure("history_lookup_failed");
  let data;
  try {
    data = await response.json();
  } catch {
    throw safetyFailure("history_lookup_failed");
  }
  if (!Number.isSafeInteger(data?.total_count) || !Array.isArray(data?.workflow_runs) ||
      data.total_count !== data.workflow_runs.length || data.total_count > 100) {
    throw safetyFailure("history_incomplete");
  }
  return data.workflow_runs;
}

export function createMediaIdRecorder() {
  const records = [];
  const summary = () => ({
    uploadedMediaCount: records.length,
    featuredMediaId: records.find((record) => record.role === "featured")?.id ?? null,
    inlineMediaIds: records.filter((record) => record.role === "inline").map((record) => record.id),
  });
  return {
    record({role, id}) {
      if (!Number.isSafeInteger(id) || id <= 0) throw safetyFailure("media_id_invalid");
      if (records.length >= 3) throw safetyFailure("media_limit_exceeded");
      if (records.some((record) => record.id === id)) throw safetyFailure("media_id_duplicate");
      if ((records.length === 0 && role !== "featured") || (records.length > 0 && role !== "inline")) {
        throw safetyFailure("media_role_invalid");
      }
      records.push({role, id});
      return summary();
    },
    summary,
    assertComplete() {
      const result = summary();
      if (result.uploadedMediaCount !== 3 || !result.featuredMediaId || result.inlineMediaIds.length !== 2) {
        throw safetyFailure("media_record_incomplete");
      }
      return result;
    },
  };
}
