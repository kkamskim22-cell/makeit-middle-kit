#!/usr/bin/env node

import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {fetchWorkflowRuns, validateApprovedFinalRunHistory} from "./lib/site-03-image-draft-safety.mjs";

const PRIOR_WORKFLOW_FILE = "site-03-image-draft-successor.yml";
const WORKFLOW_FILE = "site-03-image-draft-final.yml";
const WORKFLOW_REF = `kkamskim22-cell/makeit-middle-kit/.github/workflows/${WORKFLOW_FILE}@refs/heads/main`;
const EXPECTED_PRIOR_FAILED_RUN_ID = 45138529004;
const programRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const planPath = join(programRoot, "makeit-adsense", "inputs", "site-03", "image-draft-followup-plan.json");

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      process.env.GITHUB_WORKFLOW_REF !== WORKFLOW_REF) {
    const error = new Error("invalid_workflow_context");
    error.safeReason = "invalid_workflow_context";
    throw error;
  }
  const priorRuns = await fetchWorkflowRuns({
    repository: process.env.GITHUB_REPOSITORY,
    workflowFile: PRIOR_WORKFLOW_FILE,
    token: process.env.GH_TOKEN,
  });
  const finalRuns = await fetchWorkflowRuns({
    repository: process.env.GITHUB_REPOSITORY,
    workflowFile: WORKFLOW_FILE,
    token: process.env.GH_TOKEN,
  });
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  return validateApprovedFinalRunHistory({
    priorRuns,
    finalRuns,
    currentRunId: Number(process.env.GITHUB_RUN_ID),
    currentRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    expectedPriorFailedRunId: EXPECTED_PRIOR_FAILED_RUN_ID,
    targetTitle: plan.title,
  });
}

main()
  .then((result) => console.log(JSON.stringify({site: 3, ...result})))
  .catch((error) => {
    console.error(JSON.stringify({site: 3, guard: "blocked", reason: error?.safeReason || "unexpected_error"}));
    process.exitCode = 1;
  });
