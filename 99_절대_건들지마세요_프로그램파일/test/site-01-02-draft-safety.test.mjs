import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {selectLeastUsedChildCategoryKeys} from "../scripts/title-files.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const programRoot = dirname(here);
const repoRoot = dirname(programRoot);

test("저사용 세부 카테고리부터 서로 다르게 고른다", () => {
  const allEntries = [
    ...Array.from({length: 4}, (_, index) => ({title: `1-1-${index}`, parentCategoryNumber: 1, childCategoryNumber: 1})),
    ...Array.from({length: 4}, (_, index) => ({title: `1-2-${index}`, parentCategoryNumber: 1, childCategoryNumber: 2})),
    ...Array.from({length: 4}, (_, index) => ({title: `1-3-${index}`, parentCategoryNumber: 1, childCategoryNumber: 3})),
  ];
  const availableEntries = allEntries.filter((entry) => !["1-1-0", "1-1-1", "1-2-0"].includes(entry.title));

  assert.deepEqual(selectLeastUsedChildCategoryKeys(allEntries, availableEntries, 2), ["1-3", "1-2"]);
});

test("중복 목록 또는 개별 중복 조회 실패 시 생성하지 않도록 막는다", () => {
  const source = readFileSync(join(programRoot, "scripts", "adsense-create-drafts.mjs"), "utf8");

  assert.match(source, /워드프레스 글 목록을 안전하게 확인하지 못해 이번 실행을 멈춥니다/);
  assert.match(source, /중복 확인 실패: .*안전을 위해 이번 실행을 중단합니다/);
  assert.match(source, /status=draft,pending,future,publish,private/);
});

test("사이트 1·2 예약은 KST 기준 시간·개수·공유 저장 대기를 유지한다", () => {
  const site1 = readFileSync(join(repoRoot, ".github", "workflows", "adsense-daily-drafts-sites-01-02.yml"), "utf8");
  const site2 = readFileSync(join(repoRoot, ".github", "workflows", "adsense-daily-drafts-site-02.yml"), "utf8");

  assert.match(site1, /cron: "0 23 \* \* \*"/);
  assert.match(site1, /--site=1 --limit=2 --date-mode=now --child-category-cycle=2/);
  assert.match(site2, /cron: "30 0 \* \* \*"/);
  assert.match(site2, /2026-11-07/);
  assert.match(site2, /--site=2 --limit="\$\{DRAFT_LIMIT\}" --date-mode=now --child-category-cycle="\$\{DRAFT_LIMIT\}"/);
  assert.match(site1, /group: adsense-drafts-write-queue/);
  assert.match(site2, /group: adsense-drafts-write-queue/);
});

test("공용 사용량 기록 충돌은 글 행을 합쳐서 해결한다", () => {
  const source = readFileSync(join(programRoot, "scripts", "save.mjs"), "utf8");

  assert.match(source, /SHARED_USAGE_FILE/);
  assert.match(source, /mergeUsageConflict/);
  assert.match(source, /resolveSharedRecordConflicts/);
});
