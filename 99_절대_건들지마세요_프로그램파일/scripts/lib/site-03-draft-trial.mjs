async function readCollection({url, request, headers, onStatus}) {
  const records = [];
  let total;
  let pages;
  for (let page = 1; page <= 30; page += 1) {
    url.searchParams.set("page", String(page));
    const response = await request(url.toString(), {method: "GET", headers});
    onStatus?.(response.status, page);
    if (response.status !== 200) throw new Error(`목록 조회 HTTP ${response.status}`);
    const data = await response.json();
    const declaredTotal = response.headers.get("x-wp-total");
    const declaredPages = response.headers.get("x-wp-totalpages");
    if (!Array.isArray(data) || !/^\d+$/.test(declaredTotal ?? "") || !/^\d+$/.test(declaredPages ?? "")) {
      throw new Error("목록 응답 또는 페이지 정보가 올바르지 않습니다.");
    }
    total ??= Number(declaredTotal);
    pages ??= Number(declaredPages);
    if (Number(declaredTotal) !== total || Number(declaredPages) !== pages ||
        pages !== Math.ceil(total / 100) || pages > 30 || data.length !== Math.min(100, Math.max(0, total - (page - 1) * 100))) {
      throw new Error("목록 페이지 정보가 일치하지 않습니다.");
    }
    records.push(...data);
    if (page >= pages) break;
  }
  if (records.length !== total || new Set(records.map((record) => record?.id)).size !== total ||
      records.some((record) => !Number.isSafeInteger(record?.id) || record.id <= 0)) {
    throw new Error("전체 목록을 확인하지 못했습니다.");
  }
  return records;
}

export async function runSite03DraftTrial({siteBase, request, headers, entries, readHistory, titleKey, mapCategory, createDraft, report}) {
  const endpoint = `${siteBase}/wp-json/wp/v2`;
  const categories = await readCollection({
    url: new URL(`${endpoint}/categories?per_page=100&hide_empty=false&orderby=id&order=asc&_fields=id,name,slug,parent`),
    request, headers,
    onStatus: (httpStatus, page) => report({categoriesHttpStatus: httpStatus, page}),
  });
  const postTitle = (post) => {
    if (typeof post?.title?.raw !== "string") throw new Error("WordPress 원본 제목을 확인하지 못했습니다.");
    return titleKey(post.title.raw);
  };
  const listPosts = () => readCollection({
    url: new URL(`${endpoint}/posts?context=edit&status=draft,pending,future,publish,private,trash&per_page=100&orderby=id&order=asc&_fields=id,title`),
    request, headers,
  });

  const history = readHistory();
  const posts = await listPosts();
  const used = new Set([...posts.map(postTitle), ...history.map((entry) => titleKey(entry.title))]);
  const childIds = new Set();
  const selected = [];
  for (const entry of entries) {
    const key = titleKey(entry.title);
    if (!key || used.has(key)) continue;
    const category = mapCategory(categories, entry);
    const parentId = category?.parentId ?? category?.parent;
    if (!category?.id || !parentId || childIds.has(category.id)) continue;
    selected.push({title: entry.title, key, category, parentId});
    used.add(key);
    childIds.add(category.id);
    if (selected.length === 2) break;
  }
  if (selected.length !== 2) throw new Error("서로 다른 기존 세부 카테고리의 미사용 제목 2개를 확보하지 못했습니다.");
  report({selected: selected.map(({title, category}) => ({title, categoryId: category.id, categoryName: category.name})), existingTitleCount: posts.length, historyCount: history.length});

  let currentPosts = posts;
  const verified = [];
  for (const candidate of selected) {
    if (currentPosts.some((post) => postTitle(post) === candidate.key)) throw new Error("기존 글과 중복된 제목이 있습니다.");
    report({creating: candidate.title});
    const created = await createDraft(candidate);
    const id = created?.id;
    if (!Number.isSafeInteger(id) || id <= 0 || currentPosts.some((post) => post.id === id)) {
      throw new Error("새로 생성된 글의 ID를 확인하지 못했습니다.");
    }
    report({createdId: id, title: candidate.title});
    const response = await request(`${endpoint}/posts/${id}?context=edit&_fields=id,title,status,categories`, {method: "GET", headers});
    if (response.status !== 200) throw new Error(`임시글 재조회 HTTP ${response.status}`);
    const saved = await response.json();
    if (saved?.id !== id || saved.status !== "draft" || saved?.title?.raw !== candidate.title ||
        !Array.isArray(saved.categories) || saved.categories.length !== 2 ||
        !saved.categories.includes(candidate.category.id) || !saved.categories.includes(candidate.parentId)) {
      throw new Error("저장된 글의 제목, 상태 또는 카테고리가 예상과 다릅니다.");
    }
    currentPosts = await listPosts();
    const matches = currentPosts.filter((post) => postTitle(post) === candidate.key);
    if (matches.length !== 1 || matches[0].id !== id) throw new Error("생성 후 제목 중복 검증에 실패했습니다.");
    const result = {verified: true, id, title: candidate.title, status: saved.status, categories: saved.categories, categoryName: candidate.category.name, duplicate: false};
    verified.push(result);
    report(result);
  }
  report({verifiedCount: verified.length});
  return verified;
}
