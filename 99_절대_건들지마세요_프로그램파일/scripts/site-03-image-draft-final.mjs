#!/usr/bin/env node

import {runImageDraftFollowup} from "./site-03-image-draft-followup.mjs";

const WORKFLOW_REF = "kkamskim22-cell/makeit-middle-kit/.github/workflows/site-03-image-draft-final.yml@refs/heads/main";

runImageDraftFollowup({expectedWorkflowRef: WORKFLOW_REF, expectedCategoryIds: {parentId: 16, childId: 19}})
  .catch(() => {
    console.error(JSON.stringify({site: 3, stage: "startup", errorType: "unexpected_error", uploadedMediaCount: 0, featuredMediaId: null, inlineMediaIds: []}));
    process.exitCode = 1;
  });
