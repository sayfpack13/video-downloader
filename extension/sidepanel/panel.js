const $ = (sel) => document.querySelector(sel);
const HISTORY_KEY = "videoHistory";
/** One-time reset after removing auto-select-all behavior */
const SELECTION_RESET_KEY = "selectionResetNoAutoSelect";

let history = [];
const thumbnailRequestIds = new Set();
let activeTabUrl = "";
let sidebarPage = "videos"; // videos | downloads | settings
let videosTab = "all"; // all (visited) | current — when sidebarPage === videos

function listEl() {
  if (sidebarPage === "downloads") return $("#videoListDownloads");
  if (videosTab === "current") return $("#videoListCurrent");
  return $("#videoListVisited");
}

function hintEl() {
  if (sidebarPage === "downloads") return $("#hintDownloads");
  if (videosTab === "current") return $("#hintCurrent");
  return $("#hintVisited");
}

function findPageGroupIn(container, key) {
  if (!container || !key) return null;
  for (const el of container.querySelectorAll("details.page-group[data-page-key]")) {
    if (decodeURIComponent(el.dataset.pageKey || "") === key) return el;
  }
  return null;
}

function applyPageVisibility() {
  document.querySelectorAll(".page-view").forEach((p) => {
    const active = p.dataset.page === sidebarPage;
    p.classList.toggle("active", active);
    p.hidden = !active;
  });
  document.querySelectorAll(".nav-item").forEach((n) => {
    n.classList.toggle("active", n.dataset.nav === sidebarPage);
  });
  if (sidebarPage === "videos") updateVideosTabUi();
}

function updateVideosTabUi() {
  const tab = videosTab === "current" ? "current" : "visited";
  document.querySelectorAll(".inner-tab").forEach((btn) => {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const on = panel.dataset.tabPanel === tab;
    panel.classList.toggle("active", on);
    panel.hidden = !on;
  });
}

async function setVideosTab(tab) {
  sidebarPage = "videos";
  videosTab = tab === "current" ? "current" : "all";
  syncSelectedSet();
  applyPageVisibility();
  await send("setSettings", {
    settings: { sidebarPage: "videos", videosTab, activePage: "videos", filterMode: videosTab },
  });
  await syncActiveTab();
  await render();
}
let searchQuery = "";
let diskFiles = [];
/** @type {null | { batchId: string, total: number, done: number, queued: number, overallPercent: number, currentId?: string, currentTitle?: string, currentProgress?: number, currentLabel?: string }} */
let bulkProgress = null;
const selectedVisited = new Set();
const selectedCurrent = new Set();
let selected = selectedVisited;

function syncSelectedSet() {
  selected = videosTab === "current" ? selectedCurrent : selectedVisited;
}
let renderScheduled = false;
let refreshTimer = null;
let uiLocked = false;
let pendingRender = false;
let lastHistoryFingerprint = "";
let lastStructureFingerprint = "";
let lastProgressFingerprint = "";
/** @type {Map<string, boolean>} user expand/collapse per page key */
const pageGroupOpenState = new Map();
<<<<<<< Updated upstream
let pendingHistoryApply = null;
let pendingHistoryOpts = { renderIfChanged: true };
let historyApplyScheduled = false;
=======
/** @type {Map<string, boolean>} user expand/collapse per video id */
const videoCardOpenState = new Map();
/** @type {Map<string, object>} */
const pageFolderCache = new Map();
/** @type {Map<string, { draftValue: string, savedValue: string }>} */
const renameDrafts = new Map();
>>>>>>> Stashed changes

function historyFingerprint(h) {
  return (h || [])
    .map(
      (i) =>
        `${i.id}:${i.status}:${i.lastSeen}:${i.progress}:${i.qualitiesLoading}:${i.durationLoading}:${i.duration}:${i.selectedQualityIndex}:${i.m3u8Url}:${i.qualities?.length}`
    )
    .join("|");
}

/** List layout changes — excludes lastSeen/progress so Visited does not fully re-render on heartbeat updates */
function historyStructureFingerprint(h) {
<<<<<<< Updated upstream
  return (h || [])
    .map(
      (i) =>
        `${i.id}:${i.status}:${i.qualitiesLoading}:${i.durationLoading}:${i.duration}:${i.selectedQualityIndex}:${i.m3u8Url}:${i.qualities?.length}:${(i.title || "").slice(0, 40)}:${(i.thumbnailDataUrl || i.thumbnailUrl || "").slice(0, 48)}`
    )
    .join("|");
=======
  // Keep this fingerprint stable across status/progress changes to avoid full re-renders
  // while a stream is being detected/resolved (the UI patcher can update content in-place).
  return (h || []).map((i) => `${i.id}:${normalizePageUrl(i.pageUrl) || ""}`).join("|");
>>>>>>> Stashed changes
}

function historyProgressFingerprint(h) {
  return (h || [])
    .map((i) => `${i.id}:${i.status}:${i.progress}:${i.progressLabel || ""}`)
    .join("|");
}

function scheduleRender(force = false) {
  if (uiLocked && !force) {
    pendingRender = true;
    return;
  }
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(async () => {
    renderScheduled = false;
    await render();
  });
}

function unlockUi() {
  uiLocked = false;
  if (pendingRender) {
    pendingRender = false;
    scheduleRender();
  }
}

function isRenameControl(el) {
  return Boolean(el?.closest?.(".page-folder-input, .video-title-input"));
}

function renameKeyForInput(input) {
  if (!input) return "";
  if (input.classList.contains("page-folder-input")) {
    const url = decodeURIComponent(input.dataset.pageUrl || "");
    return url ? `folder:${normalizePageUrl(url)}` : "";
  }
  if (input.classList.contains("video-title-input")) {
    return input.dataset.id ? `video:${input.dataset.id}` : "";
  }
  return "";
}

function normRenameVal(v) {
  return (v ?? "").trim();
}

function isRenameDirty(key) {
  if (!key) return false;
  const d = renameDrafts.get(key);
  if (!d) return false;
  return normRenameVal(d.draftValue) !== normRenameVal(d.savedValue);
}

function shouldPreserveRenameInput(input) {
  if (!input) return false;
  if (document.activeElement === input) return true;
  return isRenameDirty(renameKeyForInput(input));
}

function updateRenameDirtyUi(input) {
  if (!input) return;
  const key = renameKeyForInput(input);
  const row = input.closest(".page-folder-row, .video-rename-row");
  const dirty = isRenameDirty(key);
  row?.classList.toggle("is-dirty", dirty);
  input.classList.toggle("is-dirty", dirty);
  const saveBtn = row?.querySelector(".page-folder-save, .video-title-save");
  if (saveBtn) {
    saveBtn.classList.toggle("needs-save", dirty);
    const isFolder = saveBtn.classList.contains("page-folder-save");
    saveBtn.textContent = dirty ? (isFolder ? "Apply *" : "Save *") : isFolder ? "Apply" : "Rename";
  }
  const statusEl = row?.querySelector(".rename-draft-status");
  if (statusEl) {
    statusEl.textContent = dirty ? "Unsaved changes" : "";
    statusEl.hidden = !dirty;
  }
}

function syncRenameInput(input, savedValue, { force = false } = {}) {
  if (!input) return;
  const key = renameKeyForInput(input);
  const saved = savedValue ?? "";
  if (!force && shouldPreserveRenameInput(input)) {
    updateRenameDirtyUi(input);
    return;
  }
  renameDrafts.set(key, { draftValue: saved, savedValue: saved });
  input.value = saved;
  updateRenameDirtyUi(input);
}

function clearRenameDraft(key) {
  if (key) renameDrafts.delete(key);
}

function setupUiLock() {
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.target.closest(".quality-select") || isRenameControl(e.target)) uiLocked = true;
    },
    true
  );
  document.addEventListener("focusin", (e) => {
    if (e.target.closest(".quality-select") || isRenameControl(e.target)) uiLocked = true;
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.closest(".quality-select") || isRenameControl(e.target)) {
      setTimeout(unlockUi, 250);
    }
  });
  document.addEventListener("input", (e) => {
    const input = e.target.closest?.(".page-folder-input, .video-title-input");
    if (!input) return;
    const key = renameKeyForInput(input);
    const draft = renameDrafts.get(key);
    renameDrafts.set(key, {
      draftValue: input.value,
      savedValue: draft?.savedValue ?? input.value,
    });
    updateRenameDirtyUi(input);
  });
}

function updateCurrentPageHighlight() {
  document.querySelectorAll(".video-card").forEach((card) => {
    const item = history.find((h) => h.id === card.dataset.id);
    if (!item) return;
    const isCurrent = samePage(item.pageUrl, activeTabUrl);
    card.classList.toggle("is-current", isCurrent);
  });
  document.querySelectorAll("details.page-group[data-page-key]").forEach((el) => {
    const key = decodeURIComponent(el.dataset.pageKey || "");
    const group = groupByPage(filteredList()).find((g) => g.key === key);
    if (!group) return;
    el.classList.toggle("is-active-page", samePage(group.pageUrl, activeTabUrl));
  });
}

function updateSelectionUi() {
  document.querySelectorAll(".video-card[data-id]").forEach((card) => {
    const id = card.dataset.id;
    const item = history.find((h) => h.id === id);
    const on = selected.has(id) && isBulkSelectable(item);
    card.classList.toggle("is-selected", on);
    const cb = card.querySelector(".row-check");
    if (cb) {
      if (!isBulkSelectable(item)) {
        cb.checked = false;
        cb.disabled = true;
      } else {
        cb.disabled = false;
        cb.checked = on;
      }
    }
  });
  syncSelectAll();
  updateDownloadButton();
}

function patchTimelineInPlace(block, item) {
  if (!block) return;
  const total = itemDuration(item);
  const totalStr = durationLabel(item) || "—:—";
  const loading = item.durationLoading;

  let fillPct = 0;
  let fillClass = "timeline-fill";
  let hint = loading ? "Reading video length…" : total ? "Full video length" : "Play video to detect length";

  if (item.status === "queued") {
    fillPct = 0;
    fillClass += " timeline-fill-queue";
    const pos =
      item.downloadBatchTotal > 1 && item.downloadBatchIndex != null
        ? ` · ${item.downloadBatchIndex + 1} of ${item.downloadBatchTotal}`
        : "";
    hint = `Waiting in queue${pos}`;
  } else if (item.status === "downloading") {
    const pct = item.progress ?? 0;
    const indeterminate = pct < 0;
    fillPct = indeterminate ? 35 : Math.max(0, Math.min(100, pct));
    fillClass += indeterminate ? " indeterminate" : " timeline-fill-active";
    if (total && !indeterminate) {
      const current = (total * pct) / 100;
      hint = `${formatDuration(current)} of ${totalStr} · ${pct}%`;
    } else {
      hint = item.progressLabel || "Downloading…";
    }
    if (item.downloadBatchTotal > 1 && item.downloadBatchIndex != null) {
      hint += ` · ${item.downloadBatchIndex + 1} of ${item.downloadBatchTotal}`;
    }
  } else if (item.status === "done") {
    fillPct = 100;
    fillClass += " timeline-fill-done";
    hint = total ? `Saved · ${totalStr} total` : "Downloaded";
  } else if (total) {
    fillPct = 100;
    fillClass += " timeline-fill-ready";
    hint = `Duration · ${totalStr}`;
  }

  const fill = block.querySelector(".timeline-fill");
  if (fill) {
    fill.className = fillClass;
    fill.style.width = `${fillPct}%`;
  }
  const durEl = block.querySelector(".timeline-duration");
  if (durEl) durEl.textContent = totalStr;
  const hintEl = block.querySelector(".timeline-hint");
  if (hintEl) hintEl.textContent = hint;
}

function patchQualityInPlace(card, item) {
  const qWrap = card.querySelector(".quality-inline");
  const qHtml = qualityHtml(item);
  if (!qHtml) {
    if (qWrap) qWrap.remove();
    return;
  }
  if (!qWrap) {
    const actions = card.querySelector(".card-actions");
    if (actions) actions.insertAdjacentHTML("beforebegin", qHtml);
    card.querySelectorAll(".quality-select").forEach((sel) => bindQualitySelect(sel));
    return;
  }
  if (uiLocked) return;
  const sel = qWrap.querySelector(".quality-select");
  const qualities = item.qualities || [];
  if (sel && qualities.length && sel.options.length === qualities.length) {
    const idx = item.selectedQualityIndex ?? 0;
    if (sel.value !== String(idx)) sel.value = String(idx);
    const disabled =
      item.status === "downloading" || item.status === "queued" || item.status === "done";
    sel.disabled = disabled;
    const label = qWrap.querySelector("label");
    if (label) label.textContent = "Quality";
    const wait = qWrap.querySelector("span");
    if (wait && item.qualitiesLoading) wait.textContent = "Detecting qualities…";
    return;
  }
  qWrap.outerHTML = qHtml;
}

function filteredListForTab(tab) {
  const prev = videosTab;
  videosTab = tab === "current" ? "current" : "all";
  const list = filteredList();
  videosTab = prev;
  return list;
}

function patchVideoListContainer(container, tab, { touchTimeline = true, touchQuality = true } = {}) {
  if (!container) return false;
  const list = filteredListForTab(tab);
  const groups = groupByPage(list);
  const isCurrent = tab === "current";

  if (!list.length) {
    if (container.querySelector(".empty-state")) return true;
    return false;
  }

  for (const item of list) {
    const card = container.querySelector(`.video-card[data-id="${item.id}"]`);
    if (!card) return false;

    const pill = statusPill(item);
    const pillEl = card.querySelector(".status-pill");
    if (pillEl) {
      pillEl.className = `status-pill ${pill.cls}`;
      pillEl.textContent = pill.text;
    }

<<<<<<< Updated upstream
    if (touchTimeline) patchTimelineInPlace(card.querySelector(".timeline-block"), item);

    const meta = card.querySelector(".card-meta");
    if (meta) meta.textContent = videoMetaLine(item, { compact: isCurrent });

    const titleEl = card.querySelector(".card-title");
    if (titleEl) titleEl.textContent = displayTitle(item);

    patchCardThumbnail(card, item);

    if (touchQuality) patchQualityInPlace(card, item);
=======
    const titleInput = card.querySelector(".video-title-input");
    if (titleInput) syncRenameInput(titleInput, item.title || "");
    const titleEl = card.querySelector(".card-title");
    if (titleEl && !shouldPreserveRenameInput(titleInput)) titleEl.textContent = item.title || "";

    const resetBtn = card.querySelector(".video-title-reset");
    if (resetBtn) resetBtn.disabled = !item.titleCustomized && !item.detectedTitle;

    const downloadName = card.querySelector(".download-name");
    if (downloadName && !shouldPreserveRenameInput(titleInput)) downloadName.textContent = item.title || "";

    const summaryEl = card.querySelector(".card-summary");
    if (summaryEl && card.classList.contains("is-collapsed")) {
      summaryEl.textContent = cardSummaryText(item);
    }

    const timeline = card.querySelector(".card-details .timeline-block");
    if (timeline) timeline.outerHTML = timelineHtml(item);

    const meta = card.querySelector(".card-details .card-meta");
    if (meta) {
      meta.textContent =
        videosTab === "current"
          ? formatTime(item.lastSeen)
          : `${shortPath(item.pageUrl)} · ${formatTime(item.lastSeen)}`;
    }

    // Stream info chips can change when m3u8/master/master detection completes.
    const chipsNow = chipsHtml(item);
    const existingChips = card.querySelector(".chip-row");
    if (chipsNow) {
      if (existingChips) existingChips.outerHTML = chipsNow;
      else {
        const after =
          card.querySelector(".card-details .card-meta") ||
          card.querySelector(".card-details .timeline-block") ||
          card;
        after?.insertAdjacentHTML("afterend", chipsNow);
      }
    } else if (existingChips) {
      existingChips.remove();
    }

    const qWrap = card.querySelector(".card-details .quality-inline");
    const qHtml = qualityHtml(item);
    if (qHtml && !qWrap) {
      const actions = card.querySelector(".card-details .card-actions");
      if (actions) actions.insertAdjacentHTML("beforebegin", qHtml);
    } else if (qHtml && qWrap) {
      qWrap.outerHTML = qHtml;
    } else if (!qHtml && qWrap) {
      qWrap.remove();
    }
>>>>>>> Stashed changes

    card.classList.toggle("is-current", samePage(item.pageUrl, activeTabUrl));
    card.classList.toggle("is-selected", selected.has(item.id) && isBulkSelectable(item));

    const dlBtn = card.querySelector(".dl-one");
    if (dlBtn) dlBtn.disabled = !isBulkSelectable(item);

    const rowCb = card.querySelector(".row-check");
    if (rowCb) {
      const bulkOk = isBulkSelectable(item);
      rowCb.disabled = !bulkOk;
      rowCb.checked = bulkOk && selected.has(item.id);
    }

    if (item.status === "downloading" || item.status === "queued") {
      if (card.classList.contains("is-collapsed")) {
        videoCardOpenState.set(item.id, true);
        applyVideoCardExpandedUi(card, true);
      }
    }
  }

<<<<<<< Updated upstream
  if (!isCurrent) {
    for (const group of groups) {
      const details = findPageGroupIn(container, group.key);
      if (!details) return false;
      details.classList.toggle("is-active-page", samePage(group.pageUrl, activeTabUrl));
      const timeEl = details.querySelector(".page-group-time");
      if (timeEl) timeEl.textContent = `${pageGroupSubLabel(group)} · ${formatTime(group.lastSeen)}`;
      const countEl = details.querySelector(".page-group-count");
      if (countEl) {
        countEl.textContent = `${group.items.length} video${group.items.length === 1 ? "" : "s"}`;
      }
      const sel = pageGroupSelectState(group);
      const pageCb = details.querySelector(".page-select-all");
      if (pageCb) {
        pageCb.checked = sel.checked;
        pageCb.disabled = sel.disabled;
        pageCb.indeterminate = sel.indeterminate;
      }
=======
  const hint = hintEl();
  if (videosTab === "current") {
    if (hint) {
      const pageLabel = pageHostname(activeTabUrl) || "this page";
      setText(
        hint,
        list.length
          ? `${list.length} video${list.length === 1 ? "" : "s"} on ${pageLabel}`
          : `No streams on this page — play a video to detect it.`
      );
    }
    updateStatsGrid();
    updateDownloadButton();
    updateOverallProgress();
    void refreshPageFolderInputs(container);
    refreshVideoTitleInputs(container);
    return true;
  }

  for (const group of groups) {
    const details = findPageGroupIn(container, group.key);
    if (!details) return false;
    details.classList.toggle("is-active-page", samePage(group.pageUrl, activeTabUrl));
    const timeEl = details.querySelector(".page-group-time");
    if (timeEl) timeEl.textContent = `${pageGroupSubLabel(group)} · ${formatTime(group.lastSeen)}`;
    const countEl = details.querySelector(".page-group-count");
    if (countEl) {
      countEl.textContent = `${group.items.length} video${group.items.length === 1 ? "" : "s"}`;
    }
    const sel = pageGroupSelectState(group);
    const pageCb = details.querySelector(".page-select-all");
    if (pageCb) {
      pageCb.checked = sel.checked;
      pageCb.disabled = sel.disabled;
      pageCb.indeterminate = sel.indeterminate;
>>>>>>> Stashed changes
    }
  }

  return true;
}

function updateVideosHints() {
  const visitedList = filteredListForTab("all");
  const visitedGroups = groupByPage(visitedList);
  const hintVisited = $("#hintVisited");
  if (hintVisited) {
    setText(
      hintVisited,
      searchQuery
        ? `${visitedList.length} match · ${visitedGroups.length} page${visitedGroups.length === 1 ? "" : "s"}`
        : `${visitedList.length} videos · ${visitedGroups.length} page${visitedGroups.length === 1 ? "" : "s"} visited`
    );
  }
  const currentList = filteredListForTab("current");
  const hintCurrent = $("#hintCurrent");
  if (hintCurrent) {
    const pageLabel = pageHostname(activeTabUrl) || "this page";
    setText(
      hintCurrent,
      currentList.length
        ? `${currentList.length} video${currentList.length === 1 ? "" : "s"} on ${pageLabel}`
        : `No streams on this page — play a video to detect it.`
    );
  }
}

function listContainerHasUi(container) {
  if (!container) return false;
  return Boolean(container.querySelector(".video-card, .page-group, .empty-state"));
}

function patchVideoListsUi({ touchTimeline = true, touchQuality = true } = {}) {
  if (sidebarPage !== "videos") return false;
  const visitedEl = $("#videoListVisited");
  const currentEl = $("#videoListCurrent");
  let visitedOk = true;
  let currentOk = true;
  if (listContainerHasUi(visitedEl)) {
    visitedOk = patchVideoListContainer(visitedEl, "all", { touchTimeline, touchQuality });
  }
  if (listContainerHasUi(currentEl)) {
    currentOk = patchVideoListContainer(currentEl, "current", { touchTimeline, touchQuality });
  }
  if (!visitedOk || !currentOk) return false;
  updateVideosHints();
  updateStatsGrid();
  updateDownloadButton();
  updateOverallProgress();
  void refreshPageFolderInputs(container);
  refreshVideoTitleInputs(container);
  return true;
}

function isReady(item) {
  return (
    hasStream(item) &&
    !item.qualitiesLoading &&
    item.status !== "done" &&
    item.status !== "downloading" &&
    item.status !== "queued"
  );
}

function hasStream(item) {
  return Boolean(item?.m3u8Url || item?.masterM3u8Url || item?.qualities?.length);
}

/** Eligible for bulk select / “Download selected” (excludes saved-on-disk items) */
function isBulkSelectable(item) {
  if (!item) return false;
  if (item.status === "done" || item.status === "downloading" || item.status === "queued") return false;
  if (item.fileOnDisk === true && item.file) return false;
  return hasStream(item) && !item.qualitiesLoading;
}

function selectableItems(list = filteredList()) {
  return list.filter(isBulkSelectable);
}

function pruneSelection() {
  const pruneSet = (set) => {
    let changed = false;
    for (const id of [...set]) {
      const item = history.find((h) => h.id === id);
      if (!isBulkSelectable(item)) {
        set.delete(id);
        changed = true;
      }
    }
    return changed;
  };
  return pruneSet(selectedVisited) || pruneSet(selectedCurrent);
}

async function persistSelection() {
  pruneSelection();
  await send("saveSelection", { visitedIds: [...selectedVisited], currentIds: [...selectedCurrent] });
}

async function loadSelection() {
  const data = await send("loadSelection");
  selectedVisited.clear();
  selectedCurrent.clear();

  const visitedIds = data?.visitedIds || [];
  const currentIds = data?.currentIds || [];

  for (const id of visitedIds) {
    const item = history.find((h) => h.id === id);
    if (!item || isBulkSelectable(item)) selectedVisited.add(id);
  }
  for (const id of currentIds) {
    const item = history.find((h) => h.id === id);
    if (!item || isBulkSelectable(item)) selectedCurrent.add(id);
  }

  pruneSelection();
  syncSelectedSet();
}

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }
  return `${m}:${String(ss).padStart(2, "0")}`;
}

function itemDuration(item) {
  return item.duration || item.streamInfo?.duration || null;
}

function durationLabel(item) {
  const info = item.streamInfo;
  if (info?.durationLabel) return info.durationLabel;
  return formatDuration(itemDuration(item));
}

function shortPath(url) {
  try {
    const u = new URL(url);
    if (u.hash && /^#\//.test(u.hash)) {
      const path = u.hash.replace(/^#/, "").split("?")[0];
      return path.length > 42 ? path.slice(0, 39) + "…" : path;
    }
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Must match background/service-worker.js normalizePageUrl */
function normalizePageUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.hash && /^#\//.test(u.hash)) {
      return `${u.origin}${u.pathname}${u.hash}`;
    }
    u.hash = "";
    const path = u.pathname.replace(/\/$/, "") || "/";
    return `${u.origin}${path}${u.search}`;
  } catch {
    return url;
  }
}

const VOLATILE_QUERY_RE =
  /^(playlistposition|resume|autoplay|autostart|t|time|start|end|position|index|offset|seek|continue|muted|volume|utm_|fbclid|gclid)/i;

/** Must match background/service-worker.js stablePageKey */
function stablePageKey(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.hash && /^#\//.test(u.hash)) {
      return `${u.origin}${u.pathname}${u.hash}`;
    }
    const params = new URLSearchParams(u.search);
    for (const key of [...params.keys()]) {
      if (VOLATILE_QUERY_RE.test(key)) params.delete(key);
    }
    const sorted = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const qs = new URLSearchParams(sorted).toString();
    const path = u.pathname.replace(/\/$/, "") || "/";
    return `${u.origin}${path}${qs ? `?${qs}` : ""}`;
  } catch {
    return normalizePageUrl(url);
  }
}

function samePage(a, b) {
  if (!a || !b) return false;
  return stablePageKey(a) === stablePageKey(b);
}

function pageHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Unknown site";
  }
}

function pagePathLine(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.hash && /^#\//.test(u.hash)) {
      const h = u.hash.replace(/^#/, "");
      const base = u.pathname !== "/" ? u.pathname : "";
      const line = base + h;
      return line.length > 80 ? line.slice(0, 77) + "…" : line;
    }
    const line = u.pathname + u.search;
    return line.length > 80 ? line.slice(0, 77) + "…" : line;
  } catch {
    return shortPath(url);
  }
}

function groupByPage(items) {
  const map = new Map();
  for (const item of items) {
    const key = normalizePageUrl(item.pageUrl) || "__unknown__";
    if (!map.has(key)) {
      map.set(key, {
        key,
        pageUrl: item.pageUrl || "",
        items: [],
        lastSeen: 0,
        visitedAt: null,
      });
    }
    const g = map.get(key);
    g.items.push(item);
    g.lastSeen = Math.max(g.lastSeen, item.lastSeen || 0);
    const v = item.visitedAt || item.detectedAt || item.lastSeen || 0;
    if (v && (!g.visitedAt || v < g.visitedAt)) g.visitedAt = v;
  }
  for (const g of map.values()) {
    g.items.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }
  return [...map.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

function isPageGroupOpen(group) {
  if (pageGroupOpenState.has(group.key)) {
    return pageGroupOpenState.get(group.key);
  }
  if (samePage(group.pageUrl, activeTabUrl)) return true;
  if (group.items.some((i) => i.status === "downloading" || i.status === "queued")) return true;
  return false;
}

function capturePageGroupOpenState(container) {
  if (!container) return;
  container.querySelectorAll("details.page-group[data-page-key]").forEach((el) => {
    const key = decodeURIComponent(el.dataset.pageKey || "");
    if (key) pageGroupOpenState.set(key, el.open);
  });
}

function bindPageGroupToggle(container) {
  if (!container) return;
  container.querySelectorAll("details.page-group[data-page-key]").forEach((el) => {
    el.addEventListener("toggle", () => {
      const key = decodeURIComponent(el.dataset.pageKey || "");
      if (key) pageGroupOpenState.set(key, el.open);
    });
  });
  container.querySelectorAll(".page-group-actions").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("mousedown", (e) => e.stopPropagation());
  });
}

function pageGroupSubLabel(group) {
  const ready = group.items.filter(isReady).length;
  const done = group.items.filter((i) => i.status === "done").length;
  const dl = group.items.filter((i) => i.status === "downloading").length;
  const q = group.items.filter((i) => i.status === "queued").length;
  if (dl || q) {
    if (q && dl) return `${dl} downloading · ${q} queued`;
    if (q) return `${q} queued`;
    return `${dl} downloading`;
  }
  if (ready) return `${ready} ready`;
  if (done === group.items.length) return "all saved";
  return `${done}/${group.items.length} saved`;
}

function pageGroupSelectState(group) {
  const selectable = group.items.filter(isBulkSelectable);
  if (!selectable.length) return { checked: false, indeterminate: false, disabled: true };
  const n = selectable.filter((i) => selected.has(i.id)).length;
  return {
    checked: n === selectable.length,
    indeterminate: n > 0 && n < selectable.length,
    disabled: false,
  };
}

async function syncActiveTab() {
  try {
    const res = await send("getActiveTab");
    if (res?.url) activeTabUrl = res.url;
    return res?.url || "";
  } catch {
    return activeTabUrl;
  }
}

function formatTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function statusPill(item) {
  if (item.status === "downloading") return { cls: "pill-dl", text: "Downloading" };
  if (item.status === "queued") return { cls: "pill-queue", text: "Queued" };
  if (item.status === "done") return { cls: "pill-done", text: "Done" };
  if (item.status === "error") return { cls: "pill-error", text: "Error" };
  if (item.qualitiesLoading || item.durationLoading) return { cls: "pill-wait", text: "Detecting" };
  if (isReady(item)) return { cls: "pill-ready", text: "Ready" };
  if (item.m3u8Url) return { cls: "pill-wait", text: "Processing" };
  return { cls: "pill-wait", text: "Visit" };
}

function timelineHtml(item) {
  const total = itemDuration(item);
  const totalStr = durationLabel(item) || "—:—";
  const loading = item.durationLoading;

  let fillPct = 0;
  let fillClass = "timeline-fill";
  let hint = loading ? "Reading video length…" : total ? "Full video length" : "Play video to detect length";

  if (item.status === "queued") {
    fillPct = 0;
    fillClass += " timeline-fill-queue";
    const pos =
      item.downloadBatchTotal > 1 && item.downloadBatchIndex != null
        ? ` · ${item.downloadBatchIndex + 1} of ${item.downloadBatchTotal}`
        : "";
    hint = `Waiting in queue${pos}`;
  } else if (item.status === "downloading") {
    const pct = item.progress ?? 0;
    const indeterminate = pct < 0;
    fillPct = indeterminate ? 35 : Math.max(0, Math.min(100, pct));
    fillClass += indeterminate ? " indeterminate" : " timeline-fill-active";
    if (total && !indeterminate) {
      const current = (total * pct) / 100;
      hint = `${formatDuration(current)} of ${totalStr} · ${pct}%`;
    } else {
      hint = item.progressLabel || "Downloading…";
    }
    if (item.downloadBatchTotal > 1 && item.downloadBatchIndex != null) {
      hint += ` · ${item.downloadBatchIndex + 1} of ${item.downloadBatchTotal}`;
    }
  } else if (item.status === "done") {
    fillPct = 100;
    fillClass += " timeline-fill-done";
    hint = total ? `Saved · ${totalStr} total` : "Downloaded";
  } else if (total) {
    fillPct = 100;
    fillClass += " timeline-fill-ready";
    hint = `Duration · ${totalStr}`;
  }

  return `
    <div class="timeline-block" data-timeline-id="${item.id}">
      <div class="timeline-row">
        <div class="timeline-track">
          <div class="${fillClass}" style="width:${fillPct}%"></div>
        </div>
        <span class="timeline-duration">${escapeHtml(totalStr)}</span>
      </div>
      <div class="timeline-hint">${escapeHtml(hint)}</div>
    </div>`;
}

function displayTitle(item) {
  const t = (item?.title || "").trim();
  if (t && t.length > 2 && t.toLowerCase() !== "video") return t;
  const pt = (item?.pageTitle || item?.streamInfo?.pageTitle || "").trim();
  if (pt) return pt;
  return pageHostname(item?.pageUrl) || "Video";
}

function thumbnailSrcForItem(item) {
  if (item?.thumbnailDataUrl?.startsWith("data:image/")) return item.thumbnailDataUrl;
  const url = item?.thumbnailUrl || item?.streamInfo?.thumbnailUrl || "";
  if (url?.startsWith("data:image/")) return url;
  return url;
}

function videoMetaLine(item, { compact = false } = {}) {
  const parts = [];
  const dur = durationLabel(item);
  if (dur) parts.push(dur);
  const info = item.streamInfo;
  const q = info?.selectedQuality || info?.maxQuality;
  if (q) parts.push(q);
  if (info?.selectedResolution) parts.push(info.selectedResolution);
  if (!compact) {
    const page = (item.pageTitle || info?.pageTitle || "").trim();
    if (page && page !== displayTitle(item)) parts.push(page);
    else parts.push(shortPath(item.pageUrl));
  }
  parts.push(formatTime(item.lastSeen));
  return parts.filter(Boolean).join(" · ");
}

function videoThumbnailHtml(item) {
  const src = thumbnailSrcForItem(item);
  const alt = escapeHtml(displayTitle(item));
  if (src) {
    const ref = src.startsWith("data:") ? "" : ' referrerpolicy="origin-when-cross-origin"';
    return `<div class="card-thumb"><img class="card-thumb-img" src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async"${ref} /></div>`;
  }
  return `<div class="card-thumb card-thumb-placeholder" aria-hidden="true"><span class="card-thumb-icon">▶</span></div>`;
}

function requestThumbnailIfNeeded(item) {
  if (!item?.id || thumbnailRequestIds.has(item.id)) return;
  if (thumbnailSrcForItem(item)) return;
  thumbnailRequestIds.add(item.id);
  send("ensureThumbnail", { id: item.id }).catch(() => {});
}

function requestThumbnailsForList(list) {
  for (const item of list) requestThumbnailIfNeeded(item);
}

function patchCardThumbnail(card, item) {
  const src = thumbnailSrcForItem(item);
  let thumb = card.querySelector(".card-thumb");
  if (!src) {
    if (!thumb) {
      card.insertAdjacentHTML("afterbegin", videoThumbnailHtml(item));
    }
    requestThumbnailIfNeeded(item);
    return;
  }
  if (!thumb) {
    const check = card.querySelector(".card-check");
    if (check) check.insertAdjacentHTML("afterend", videoThumbnailHtml(item));
    else card.insertAdjacentHTML("afterbegin", videoThumbnailHtml(item));
    thumb = card.querySelector(".card-thumb");
    bindCardThumbnails(card.closest(".video-list") || card.parentElement || document);
  }
  const img = thumb?.querySelector(".card-thumb-img");
  if (img && img.src !== src) {
    img.src = src;
    thumb.classList.remove("card-thumb-placeholder", "card-thumb-broken");
  }
}

function chipsHtml(item) {
  const info = item.streamInfo;
  if (!info && !item.m3u8Url) return "";

  const chips = [];
  if (info?.format) chips.push(`<span class="chip">${escapeHtml(info.format)}</span>`);
  const dur = info?.durationLabel || durationLabel(item);
  if (dur) chips.push(`<span class="chip chip-dur">${escapeHtml(dur)}</span>`);
  if (info?.selectedQuality) {
    const q =
      info.qualityCount > 1
        ? `${info.selectedQuality} · ${info.qualityCount} qualities`
        : info.selectedQuality;
    chips.push(`<span class="chip chip-q">${escapeHtml(q)}</span>`);
  } else if (info?.maxQuality) {
    chips.push(`<span class="chip chip-q">${escapeHtml(info.maxQuality)}</span>`);
  }
  if (info?.streamId) chips.push(`<span class="chip" title="Stream asset ID">${escapeHtml(info.streamId)}</span>`);
  if (info?.cdnHost) chips.push(`<span class="chip" title="CDN">${escapeHtml(info.cdnHost)}</span>`);
  if (!chips.length) return "";
  return `<div class="chip-row">${chips.join("")}</div>`;
}

function qualityHtml(item) {
  if (!item.m3u8Url && !item.qualities?.length) return "";
  if (item.qualitiesLoading) {
    return `<div class="quality-inline"><span style="color:var(--wait)">Detecting qualities…</span></div>`;
  }
  const qualities = item.qualities || [];
  if (!qualities.length) return "";
  const idx = item.selectedQualityIndex ?? 0;
  const disabled =
    item.status === "downloading" || item.status === "queued" || item.status === "done" ? "disabled" : "";
  const options = qualities
    .map((q, i) => {
      const extra = q.resolution ? ` · ${q.resolution}` : "";
      return `<option value="${i}" ${i === idx ? "selected" : ""}>${escapeHtml(q.label + extra)}</option>`;
    })
    .join("");
  return `
    <div class="quality-inline">
      <label>Quality</label>
      <select class="quality-select" data-id="${item.id}" ${disabled}>${options}</select>
    </div>`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function streamDisplayKey(item) {
  const page = stablePageKey(item.pageUrl) || "__unknown__";
  const title = (item.title || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 100);
  const dur = item.duration > 0 ? Math.round(item.duration) : 0;
  if (title.length >= 4) {
    return dur > 0 ? `${page}|${title}|${dur}` : `${page}|${title}`;
  }
  const stream =
    item.streamInfo?.streamKey ||
    item.videoId ||
    item.m3u8Url ||
    item.masterM3u8Url ||
    item.id;
  return `${page}|${stream}`;
}

/** Last line of defense if storage ever contains duplicate stream rows */
function dedupeDisplayList(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = streamDisplayKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function filteredList() {
  if (sidebarPage === "downloads") {
    return dedupeDisplayList(
      history
        .filter((h) => h.downloadedAt || h.status === "done" || h.file)
        .sort((a, b) => (b.downloadedAt || b.lastSeen || 0) - (a.downloadedAt || a.lastSeen || 0))
    );
  }
  const page = normalizePageUrl(activeTabUrl);
  let list =
    videosTab === "current"
      ? history.filter((h) => samePage(h.pageUrl, page))
      : history;
  if (videosTab === "all" && searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    list = list.filter(
      (h) =>
        (h.title || "").toLowerCase().includes(q) ||
        (h.pageTitle || "").toLowerCase().includes(q) ||
        (h.pageUrl || "").toLowerCase().includes(q) ||
        (h.streamInfo?.streamId || "").toLowerCase().includes(q) ||
        (h.streamInfo?.pageTitle || "").toLowerCase().includes(q)
    );
  }
  return dedupeDisplayList(list);
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function updateStatsGrid() {
  setText($("#statTotal"), history.length);
  setText($("#statReady"), history.filter(isReady).length);
  setText(
    $("#statWait"),
    history.filter(
      (h) =>
        !isReady(h) &&
        h.status !== "done" &&
        h.status !== "downloading" &&
        (h.m3u8Url || h.qualitiesLoading)
    ).length
  );
  setText($("#statDone"), history.filter((h) => h.status === "done").length);

  const onPage = history.filter((h) => samePage(h.pageUrl, activeTabUrl));
  setText($("#statCurrentTotal"), onPage.length);
  setText($("#statCurrentReady"), onPage.filter(isReady).length);
  setText($("#statCurrentDone"), onPage.filter((h) => h.status === "done").length);
}

function updateDownloadButton() {
  const downloadable = [...selected].filter((id) => isBulkSelectable(history.find((h) => h.id === id)));
  const count = downloadable.length;
  const label = `Download selected (${count})`;
  document.querySelectorAll(".btn-download-selected").forEach((btn) => {
    btn.textContent = label;
    btn.disabled = count === 0;
  });
}

function getActiveBatchGroups(list = history) {
  const map = new Map();
  for (const item of list) {
    if (!item.downloadBatchId) continue;
    if (!map.has(item.downloadBatchId)) map.set(item.downloadBatchId, []);
    map.get(item.downloadBatchId).push(item);
  }
  return [...map.values()]
    .filter((items) => items.some((i) => i.status === "downloading" || i.status === "queued"))
    .map((items) => ({
      items: [...items].sort((a, b) => (a.downloadBatchIndex ?? 0) - (b.downloadBatchIndex ?? 0)),
      total: items[0]?.downloadBatchTotal || items.length,
    }));
}

function computeBatchOverallFromHistory(batchItems, total) {
  const done = batchItems.filter((h) => h.status === "done").length;
  const queued = batchItems.filter((h) => h.status === "queued").length;
  const current = batchItems.find((h) => h.status === "downloading");
  const curPct = current?.progress ?? 0;
  const curProgress = curPct < 0 ? 0 : Math.min(100, curPct);
  const overallPercent = total ? Math.min(100, Math.round((done * 100 + curProgress) / total)) : 0;
  const currentIndex = current != null ? done + 1 : done;
  return { done, queued, total, current, overallPercent, currentIndex, indeterminate: curPct < 0 };
}

function updateOverallProgress() {
  const downloading = history.filter((h) => h.status === "downloading");
  const queued = history.filter((h) => h.status === "queued");
  const box = $("#overallProgress");
  const hintEl = $("#overallHint");
  if (!box) return;

  if (!downloading.length && !queued.length) {
    box.classList.add("hidden");
    bulkProgress = null;
    if (hintEl) hintEl.textContent = "";
    return;
  }

  box.classList.remove("hidden");
  const bar = $("#overallBar");
  const batches = getActiveBatchGroups();
  const batch = batches[0];
  const isBulk = batch && batch.total > 1;

  let overallPercent = -1;
  let indeterminate = false;
  let label = "";
  let hint = "";

  if (bulkProgress && (downloading.length || queued.length)) {
    const { total, done, queued: q, overallPercent: pct, currentTitle, currentProgress, currentLabel } =
      bulkProgress;
    overallPercent = pct;
    indeterminate = currentProgress != null && currentProgress < 0;
    const currentNum = Math.min(total, done + (downloading.length ? 1 : 0));
    label = total > 1 ? `Bulk download · ${currentNum} of ${total}` : currentTitle || "Downloading…";
    const parts = [];
    if (done) parts.push(`${done} completed`);
    if (q) parts.push(`${q} waiting`);
    if (currentTitle && downloading.length) {
      const cur =
        currentProgress != null && currentProgress >= 0
          ? `${currentProgress}%`
          : currentLabel || "in progress";
      parts.push(`Now: ${currentTitle} (${cur})`);
    }
    hint = parts.join(" · ");
  } else if (isBulk) {
    const stats = computeBatchOverallFromHistory(batch.items, batch.total);
    overallPercent = stats.overallPercent;
    indeterminate = stats.indeterminate;
    const currentNum = stats.current ? stats.currentIndex : stats.done;
    label = `Bulk download · ${currentNum} of ${stats.total}`;
    const parts = [];
    if (stats.done) parts.push(`${stats.done} completed`);
    if (stats.queued) parts.push(`${stats.queued} waiting`);
    if (stats.current) {
      const p = stats.current.progress ?? 0;
      const cur = p >= 0 ? `${p}%` : stats.current.progressLabel || "in progress";
      parts.push(`Now: ${stats.current.title || "video"} (${cur})`);
    }
    hint = parts.join(" · ");
  } else {
    const item = downloading[0] || queued[0];
    overallPercent = item?.progress ?? 0;
    indeterminate = overallPercent < 0;
    label = item?.title || "Downloading…";
    hint = item?.progressLabel || (queued.length ? "Waiting to start…" : "Downloading…");
  }

  setText($("#overallLabel"), label);
  if (hintEl) hintEl.textContent = hint;

  if (!bar) return;
  if (indeterminate || overallPercent < 0) {
    bar.className = "timeline-fill indeterminate";
    bar.style.width = "35%";
    setText($("#overallPercent"), isBulk && batch ? `${batch.total} videos` : "");
  } else {
    bar.className = "timeline-fill timeline-fill-active";
    bar.style.width = `${overallPercent}%`;
    setText($("#overallPercent"), `${overallPercent}%`);
  }
}

function applyProgressToRow(id, progress, progressLabel) {
  const item = history.find((h) => h.id === id);
  if (item) {
    item.progress = progress;
    item.progressLabel = progressLabel;
  }
  document.querySelectorAll(`[data-timeline-id="${id}"]`).forEach((block) => {
    if (item) patchTimelineInPlace(block, item);
  });
  updateOverallProgress();
}

async function loadDownloadsView() {
  const sync = await send("syncDownloads");
  const { settings } = await send("getSettings");
  const outputDir = settings?.outputDir?.trim();
  if (!outputDir) {
    diskFiles = [];
    return sync;
  }
  const res = await send("listDownloadDir", { outputDir });
  diskFiles = res?.ok ? res.files || [] : [];
  return sync;
}

function preserveListScroll(container) {
  if (!container) return () => {};
  const top = container.scrollTop;
  return () => {
    container.scrollTop = top;
  };
}

async function renderDownloads() {
  const container = $("#videoListDownloads");
  const hint = $("#hintDownloads");
  if (!container || !hint) return;

  const restoreScroll = preserveListScroll(container);
  const sync = await loadDownloadsView();
  const doneItems = filteredList();
  const groups = groupByPage(doneItems);
  capturePageGroupOpenState(container);

  const onDiskCount = doneItems.filter((h) => h.fileOnDisk === true).length;
  const missingCount = doneItems.filter((h) => h.downloadedAt && h.fileOnDisk !== true).length;
  const pageCount = groups.length;
  setText(hint, `${onDiskCount} on disk · ${missingCount} missing · ${pageCount} page${pageCount === 1 ? "" : "s"}`);
  if (sync?.linked) hint.textContent += ` · ${sync.linked} linked`;

  if (!doneItems.length && !diskFiles.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>No downloads yet</strong>
        Download videos from the Visited tab — they will appear here grouped by page.
      </div>`;
    restoreScroll();
    return;
  }
  const rows = groups
    .map((group) => {
      const isActive = samePage(group.pageUrl, activeTabUrl);
      const open = isPageGroupOpen(group);
      return `
      <details class="page-group ${isActive ? "is-active-page" : ""}" ${open ? "open" : ""}>
        <summary class="page-group-summary">
          <div class="page-group-info">
            <span class="page-group-host">${escapeHtml(pageHostname(group.pageUrl))}</span>
            <span class="page-group-path" title="${escapeHtml(group.pageUrl)}">${escapeHtml(pagePathLine(group.pageUrl) || "Unknown page")}</span>
          </div>
          <div class="page-group-meta">
            <span class="page-group-count">${group.items.length} saved</span>
            <span class="page-group-time">${formatTime(group.lastSeen)}</span>
          </div>
          <div class="page-group-actions">
            <button class="btn-action btn-sm open-page-url" data-url="${encodeURIComponent(group.pageUrl)}" type="button">Open</button>
          </div>
        </summary>
        <div class="page-group-body">
          ${group.items.map((item) => downloadCardHtml(item, { compact: true })).join("")}
        </div>
      </details>`;
    })
    .join("");

  const orphanSection =
    diskFiles.length && doneItems.length < diskFiles.length
      ? `<p class="hint" style="margin-top:12px">Other files in folder (${diskFiles.length - doneItems.length} not linked to history):</p>
         ${diskFiles
           .filter((f) => !doneItems.some((h) => (h.file || "").replace(/\\/g, "/").toLowerCase() === f.path.replace(/\\/g, "/").toLowerCase()))
           .slice(0, 20)
           .map(
             (f) => `
           <article class="download-card">
             <p class="download-name">${escapeHtml(f.name)}</p>
             <p class="download-path">${escapeHtml(f.folder ? `${f.folder}/` : "")}${escapeHtml(f.name)}</p>
             <p class="download-meta">${formatFileSize(f.size)}</p>
             <div class="card-actions">
               <button class="btn-action open-file-orphan" data-path="${encodeURIComponent(f.path)}" type="button">Play file</button>
               <button class="btn-action open-folder-orphan" data-path="${encodeURIComponent(f.path)}" type="button">Show in folder</button>
             </div>
           </article>`
           )
           .join("")}`
      : "";

  container.innerHTML = rows + orphanSection;
  bindDownloadListEvents(container);
  bindPageGroupToggle(container);
  restoreScroll();
}

function pathNormKey(p) {
  if (!p) return "";
  return p.replace(/\\/g, "/").toLowerCase();
}

function videoRenameRowHtml(item) {
  return `
    <div class="video-rename-row" data-id="${item.id}">
      <span class="video-rename-label">Name</span>
      <input type="text" class="video-title-input" data-id="${item.id}" placeholder="Video name" spellcheck="false" />
      <button class="btn-action btn-sm video-title-save" data-id="${item.id}" type="button">Rename</button>
      <button class="btn-action btn-sm video-title-reset" data-id="${item.id}" type="button" title="Restore detected name">Reset</button>
      <span class="rename-draft-status" hidden></span>
    </div>`;
}

function refreshVideoTitleInputs(root = document, { force = false } = {}) {
  root.querySelectorAll(".video-rename-row").forEach((row) => {
    const id = row.dataset.id;
    const item = history.find((h) => h.id === id);
    const input = row.querySelector(".video-title-input");
    const resetBtn = row.querySelector(".video-title-reset");
    if (!item || !input) return;
    syncRenameInput(input, item.title || "", { force });
    if (resetBtn) resetBtn.disabled = !item.titleCustomized && !item.detectedTitle;
  });
}

async function saveVideoTitle(itemId, rawTitle) {
  const res = await send("renameVideo", { id: itemId, title: rawTitle });
  if (!res?.ok) {
    alert(res?.error || "Could not rename video");
    return false;
  }
  const key = `video:${itemId}`;
  clearRenameDraft(key);
  const item = history.find((h) => h.id === itemId);
  const container = listEl();
  const input = container?.querySelector(`.video-title-input[data-id="${itemId}"]`);
  if (input) syncRenameInput(input, item?.title || res.title || rawTitle, { force: true });
  await refresh({ fullRender: false });
  return true;
}

function bindVideoRenameEvents(container) {
  if (!container) return;
  container.querySelectorAll(".video-rename-row").forEach((row) => {
    row.addEventListener("click", (e) => e.stopPropagation());
    row.addEventListener("mousedown", (e) => e.stopPropagation());
  });
  container.querySelectorAll(".video-title-save").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const input = container.querySelector(`.video-title-input[data-id="${id}"]`);
      if (!id || !input) return;
      btn.disabled = true;
      await saveVideoTitle(id, input.value);
      btn.disabled = false;
    });
  });
  container.querySelectorAll(".video-title-reset").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!id) return;
      btn.disabled = true;
      const res = await send("resetVideoTitle", { id });
      if (!res?.ok) alert(res?.error || "Could not reset name");
      else await refresh({ fullRender: false });
      btn.disabled = false;
    });
  });
  container.querySelectorAll(".video-title-input").forEach((input) => {
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      await saveVideoTitle(input.dataset.id, input.value);
    });
  });
}

function defaultVideoCardExpanded(item, { compact = false } = {}) {
  if (item.status === "downloading" || item.status === "queued" || item.status === "error") return true;
  return !compact;
}

function isVideoCardExpanded(item, opts = {}) {
  if (videoCardOpenState.has(item.id)) return videoCardOpenState.get(item.id);
  return defaultVideoCardExpanded(item, opts);
}

function cardSummaryText(item) {
  const parts = [];
  const dur = durationLabel(item);
  if (dur) parts.push(dur);
  if (item.streamInfo?.maxQuality) {
    const q =
      item.streamInfo.qualityCount > 1
        ? `${item.streamInfo.maxQuality} +${item.streamInfo.qualityCount - 1}`
        : item.streamInfo.maxQuality;
    parts.push(q);
  }
  if (item.status === "downloading") {
    const pct = item.progress ?? 0;
    parts.push(pct >= 0 ? `${pct}%` : item.progressLabel || "Downloading");
  } else if (item.status === "queued") {
    parts.push("Queued");
  }
  if (!parts.length) parts.push(statusPill(item).text);
  return parts.join(" · ");
}

function cardSummaryHtml(item) {
  return `<div class="card-summary">${escapeHtml(cardSummaryText(item))}</div>`;
}

function captureVideoCardOpenState(container) {
  if (!container) return;
  container.querySelectorAll(".video-card[data-id]").forEach((card) => {
    const id = card.dataset.id;
    if (id) videoCardOpenState.set(id, !card.classList.contains("is-collapsed"));
  });
}

function setAllVideoCardsExpanded(container, expanded, list = filteredList()) {
  for (const item of list) {
    videoCardOpenState.set(item.id, expanded);
  }
  container?.querySelectorAll(".video-card[data-id]").forEach((card) => {
    const id = card.dataset.id;
    if (!list.some((i) => i.id === id)) return;
    applyVideoCardExpandedUi(card, expanded);
  });
}

function applyVideoCardExpandedUi(card, expanded) {
  if (!card) return;
  const item = history.find((h) => h.id === card.dataset.id);
  card.classList.toggle("is-collapsed", !expanded);
  const btn = card.querySelector(".card-expand-btn");
  if (btn) {
    btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    btn.textContent = expanded ? "▾" : "▸";
    btn.title = expanded ? "Collapse details" : "Expand details";
  }
  let summary = card.querySelector(".card-summary");
  if (!expanded) {
    if (!summary && item) {
      const headText = card.querySelector(".card-head-text");
      headText?.insertAdjacentHTML("beforeend", cardSummaryHtml(item));
    } else if (summary && item) {
      summary.textContent = cardSummaryText(item);
    }
  } else if (summary) {
    summary.remove();
  }
}

function videoCardHtml(item, { compact = false } = {}) {
  const bulkOk = isBulkSelectable(item);
  const checked = bulkOk && selected.has(item.id) ? "checked" : "";
  const isCurrent = samePage(item.pageUrl, activeTabUrl) ? "is-current" : "";
  const isSel = bulkOk && selected.has(item.id) ? "is-selected" : "";
  const canDownload = bulkOk;
  const pill = statusPill(item);
<<<<<<< Updated upstream
  const meta = videoMetaLine(item, { compact });
=======
  const expanded = isVideoCardExpanded(item, { compact });
  const meta = compact
    ? formatTime(item.lastSeen)
    : `${escapeHtml(shortPath(item.pageUrl))} · ${formatTime(item.lastSeen)}`;
>>>>>>> Stashed changes
  return `
    <article class="video-card ${compact ? "compact" : ""} ${isCurrent} ${isSel} ${expanded ? "" : "is-collapsed"}" data-id="${item.id}">
      <div class="card-check">
        <input type="checkbox" class="row-check" data-id="${item.id}" ${checked}
          ${bulkOk ? "" : "disabled"} />
      </div>
      ${videoThumbnailHtml(item)}
      <div class="card-body">
        <div class="card-head">
<<<<<<< Updated upstream
          <h3 class="card-title">${escapeHtml(displayTitle(item))}</h3>
=======
          <button type="button" class="card-expand-btn" data-id="${item.id}" aria-expanded="${expanded ? "true" : "false"}" title="${expanded ? "Collapse details" : "Expand details"}">${expanded ? "▾" : "▸"}</button>
          <div class="card-head-text">
            <h3 class="card-title">${escapeHtml(item.title)}</h3>
            ${expanded ? "" : cardSummaryHtml(item)}
          </div>
>>>>>>> Stashed changes
          <span class="status-pill ${pill.cls}">${pill.text}</span>
        </div>
        <div class="card-details">
          ${videoRenameRowHtml(item)}
          ${timelineHtml(item)}
          <div class="card-meta">${meta}</div>
          ${chipsHtml(item)}
          ${qualityHtml(item)}
          <div class="card-actions">
            <button class="btn-action open-page" data-id="${item.id}" type="button">Open</button>
            <button class="btn-action btn-dl dl-one" data-id="${item.id}" type="button" ${canDownload ? "" : "disabled"}>Download</button>
            <button class="btn-action btn-rm rm-one" data-id="${item.id}" type="button">Remove</button>
          </div>
        </div>
      </div>
    </article>`;
}

function pageFolderRowHtml(pageUrl) {
  return `
    <div class="page-folder-row" data-page-url="${encodeURIComponent(pageUrl)}">
      <div class="page-folder-head">
        <span class="page-folder-label">Save folder</span>
        <span class="page-folder-display"></span>
      </div>
      <div class="page-folder-controls">
        <input type="text" class="page-folder-input" data-page-url="${encodeURIComponent(pageUrl)}" placeholder="Auto from URL" spellcheck="false" />
        <button class="btn-action btn-sm page-folder-save" type="button">Apply</button>
        <button class="btn-action btn-sm page-folder-reset" type="button" title="Use automatic folder name">Reset</button>
        <span class="rename-draft-status" hidden></span>
      </div>
    </div>`;
}

async function fetchPageFolderInfo(pageUrl) {
  const key = normalizePageUrl(pageUrl);
  if (pageFolderCache.has(key)) return pageFolderCache.get(key);
  const info = await send("getPageFolderInfo", { pageUrl });
  pageFolderCache.set(key, info || {});
  return info;
}

async function refreshPageFolderInputs(root = document, { force = false } = {}) {
  const rows = root.querySelectorAll(".page-folder-row");
  await Promise.all(
    [...rows].map(async (row) => {
      const url = decodeURIComponent(row.dataset.pageUrl || "");
      if (!url) return;
      const info = await fetchPageFolderInfo(url);
      const input = row.querySelector(".page-folder-input");
      const display = row.querySelector(".page-folder-display");
      const saved = info?.isCustom ? info.customName || "" : "";
      if (input) {
        syncRenameInput(input, saved, { force });
        input.placeholder = info?.autoName || "Auto from URL";
      }
      if (display && !shouldPreserveRenameInput(input)) {
        display.textContent = info?.effectiveName
          ? `Files save to: ${info.effectiveName}/`
          : "";
      }
    })
  );
}

async function savePageFolderName(pageUrl, rawName) {
  const key = normalizePageUrl(pageUrl);
  const res = await send("setPageFolderName", { pageUrl, name: rawName });
  if (!res?.ok) {
    alert(res?.error || "Could not update folder name");
    return false;
  }
  pageFolderCache.delete(key);
  clearRenameDraft(`folder:${key}`);
  const container = listEl();
  const row = container?.querySelector(
    `.page-folder-row[data-page-url="${encodeURIComponent(pageUrl)}"]`
  );
  const input = row?.querySelector(".page-folder-input");
  const info = await fetchPageFolderInfo(pageUrl);
  const saved = info?.isCustom ? info.customName || "" : "";
  if (input) syncRenameInput(input, saved, { force: true });
  await refresh({ fullRender: false });
  return true;
}

function bindPageFolderEvents(container) {
  if (!container) return;
  container.querySelectorAll(".page-folder-row").forEach((row) => {
    row.addEventListener("click", (e) => e.stopPropagation());
    row.addEventListener("mousedown", (e) => e.stopPropagation());
  });
  container.querySelectorAll(".page-folder-save").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const row = btn.closest(".page-folder-row");
      const url = decodeURIComponent(row?.dataset.pageUrl || "");
      const input = row?.querySelector(".page-folder-input");
      if (!url || !input) return;
      btn.disabled = true;
      await savePageFolderName(url, input.value);
      btn.disabled = false;
    });
  });
  container.querySelectorAll(".page-folder-reset").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const row = btn.closest(".page-folder-row");
      const url = decodeURIComponent(row?.dataset.pageUrl || "");
      const input = row?.querySelector(".page-folder-input");
      if (!url) return;
      if (input) input.value = "";
      btn.disabled = true;
      await savePageFolderName(url, "");
      btn.disabled = false;
    });
  });
  container.querySelectorAll(".page-folder-input").forEach((input) => {
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopPropagation();
      const row = input.closest(".page-folder-row");
      const url = decodeURIComponent(row?.dataset.pageUrl || "");
      if (!url) return;
      await savePageFolderName(url, input.value);
    });
  });
}

function pageGroupHtml(group) {
  const isActive = samePage(group.pageUrl, activeTabUrl);
  const open = isPageGroupOpen(group);
  const sel = pageGroupSelectState(group);
  const ind = sel.indeterminate ? ' data-indeterminate="1"' : "";
  return `
    <details class="page-group ${isActive ? "is-active-page" : ""}" data-page-key="${encodeURIComponent(group.key)}" ${open ? "open" : ""}>
      <summary class="page-group-summary">
        <div class="page-group-info">
          <span class="page-group-host">${escapeHtml(pageHostname(group.pageUrl))}</span>
          <span class="page-group-path" title="${escapeHtml(group.pageUrl)}">${escapeHtml(pagePathLine(group.pageUrl) || "/")}</span>
        </div>
        <div class="page-group-meta">
          <span class="page-group-count">${group.items.length} video${group.items.length === 1 ? "" : "s"}</span>
          <span class="page-group-time">${pageGroupSubLabel(group)} · ${formatTime(group.lastSeen)}</span>
        </div>
        <div class="page-group-actions">
          <label class="page-select-pill" title="Select all on this page">
            <input type="checkbox" class="page-select-all" data-page-key="${encodeURIComponent(group.key)}" ${sel.checked ? "checked" : ""} ${sel.disabled ? "disabled" : ""}${ind} />
            <span>All</span>
          </label>
          <button class="btn-action btn-sm open-page-url" data-url="${encodeURIComponent(group.pageUrl)}" type="button">Open</button>
        </div>
      </summary>
      <div class="page-group-body">
        ${pageFolderRowHtml(group.pageUrl)}
        ${group.items.map((item) => videoCardHtml(item, { compact: true })).join("")}
      </div>
    </details>`;
}

function currentPageBannerHtml() {
  if (!activeTabUrl) return "";
  return `
    <div class="page-banner is-active">
      <div class="page-banner-header">
        <div class="page-banner-text">
          <span class="page-banner-host">${escapeHtml(pageHostname(activeTabUrl))}</span>
          <span class="page-banner-url" title="${escapeHtml(activeTabUrl)}">${escapeHtml(pagePathLine(activeTabUrl))}</span>
        </div>
        <div class="page-banner-actions">
          <button class="btn-action btn-sm focus-tab" type="button" title="Focus browser tab">Tab ↗</button>
        </div>
      </div>
      ${pageFolderRowHtml(activeTabUrl)}
    </div>`;
}

<<<<<<< Updated upstream
function bindQualitySelect(sel) {
  sel.addEventListener("change", async () => {
    uiLocked = false;
    pendingRender = false;
    await send("setQuality", { id: sel.dataset.id, index: parseInt(sel.value, 10) });
    await refresh({ fullRender: true });
  });
}

function bindCardThumbnails(container) {
  container.querySelectorAll(".card-thumb-img").forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        const thumb = img.closest(".card-thumb");
        if (!thumb) return;
        img.remove();
        thumb.classList.add("card-thumb-placeholder", "card-thumb-broken");
        if (!thumb.querySelector(".card-thumb-icon")) {
          thumb.innerHTML = '<span class="card-thumb-icon">▶</span>';
        }
      },
      { once: true }
    );
=======
function bindVideoCardExpand(container) {
  if (!container) return;
  container.querySelectorAll(".card-expand-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".video-card");
      const id = btn.dataset.id || card?.dataset.id;
      if (!card || !id) return;
      const expanded = card.classList.contains("is-collapsed");
      videoCardOpenState.set(id, expanded);
      applyVideoCardExpandedUi(card, expanded);
    });
  });
  container.querySelectorAll(".card-head").forEach((head) => {
    head.addEventListener("dblclick", (e) => {
      if (e.target.closest(".card-expand-btn, .row-check, .status-pill")) return;
      const card = head.closest(".video-card");
      const btn = card?.querySelector(".card-expand-btn");
      btn?.click();
    });
>>>>>>> Stashed changes
  });
}

function bindVideoListEvents(container) {
<<<<<<< Updated upstream
  bindCardThumbnails(container);
=======
  bindVideoCardExpand(container);
>>>>>>> Stashed changes
  container.querySelectorAll(".row-check").forEach((cb) => {
    cb.addEventListener("change", () => {
      const item = history.find((h) => h.id === cb.dataset.id);
      if (!isBulkSelectable(item)) {
        cb.checked = false;
        return;
      }
      if (cb.checked) selected.add(cb.dataset.id);
      else selected.delete(cb.dataset.id);
      persistSelection();
      updateSelectionUi();
      updateDownloadButton();
    });
  });

  container.querySelectorAll(".open-page").forEach((btn) => {
    btn.addEventListener("click", () => send("openPage", { id: btn.dataset.id }));
  });

  container.querySelectorAll(".open-page-url").forEach((btn) => {
    btn.addEventListener("click", () => {
      const url = decodeURIComponent(btn.dataset.url || "");
      if (url) chrome.tabs.create({ url });
    });
  });

  container.querySelectorAll(".focus-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (tab?.id) chrome.tabs.update(tab.id, { active: true });
        if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true });
      });
    });
  });

  container.querySelectorAll(".page-select-all").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      const key = decodeURIComponent(cb.dataset.pageKey || "");
      const group = groupByPage(filteredList()).find((g) => g.key === key);
      if (!group) return;
      for (const item of group.items) {
        if (!isBulkSelectable(item)) continue;
        if (cb.checked) selected.add(item.id);
        else selected.delete(item.id);
      }
      persistSelection();
      updateSelectionUi();
    });
    if (cb.dataset.indeterminate === "1") cb.indeterminate = true;
  });

  container.querySelectorAll(".dl-one").forEach((btn) => {
    btn.addEventListener("click", () => downloadIds([btn.dataset.id]));
  });

  container.querySelectorAll(".rm-one").forEach((btn) => {
    btn.addEventListener("click", async () => {
      selected.delete(btn.dataset.id);
      await send("removeItems", { ids: [btn.dataset.id] });
      await refresh();
    });
  });

  container.querySelectorAll(".quality-select").forEach((sel) => bindQualitySelect(sel));
}

function downloadCardHtml(item, { compact = false } = {}) {
  const filePath = item.file || "";
  const norm = pathNormKey(filePath);
  const onDisk = item.fileOnDisk === true || (norm && diskFiles.some((f) => pathNormKey(f.path) === norm));
  const disk = diskFiles.find((f) => pathNormKey(f.path) === norm);
  const size = disk?.size ?? item.fileSize;
  const fileName = filePath ? filePath.split(/[/\\]/).pop() : "—";
  const pathParts = filePath ? filePath.replace(/\\/g, "/").split("/") : [];
  const parentFolder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : "";
  const pathLabel = parentFolder ? `${parentFolder}/${fileName}` : fileName || "—";
  const missing = item.downloadedAt && !onDisk;

  return `
    <article class="download-card ${missing ? "missing" : ""} ${compact ? "compact" : ""}" data-id="${item.id}">
      <p class="download-name">${escapeHtml(item.title)}</p>
      ${videoRenameRowHtml(item)}
      <p class="download-path" title="${escapeHtml(filePath)}">${escapeHtml(pathLabel)}</p>
      <p class="download-meta">
        ${
          missing
            ? '<span class="status-pill pill-missing">Removed from disk — re-download</span>'
            : onDisk
              ? `<span class="status-pill pill-done">On disk · ${formatFileSize(size)}</span>`
              : `<span class="status-pill pill-wait">${escapeHtml(item.status)}</span>`
        }
      </p>
      <div class="card-actions">
        <button class="btn-action open-file" data-id="${item.id}" type="button" ${filePath && onDisk ? "" : "disabled"}>Play file</button>
        <button class="btn-action open-folder-file" data-id="${item.id}" type="button" ${filePath ? "" : "disabled"}>Show in folder</button>
        <button class="btn-action btn-dl redownload-one" data-id="${item.id}" type="button">${missing || !onDisk ? "Download" : "Re-download"}</button>
      </div>
    </article>`;
}

function bindDownloadListEvents(container) {
  bindVideoRenameEvents(container);
  refreshVideoTitleInputs(container);
  container.querySelectorAll(".open-file").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = history.find((h) => h.id === btn.dataset.id);
      if (item?.file) send("openFile", { path: item.file });
    });
  });

  container.querySelectorAll(".open-folder-file").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = history.find((h) => h.id === btn.dataset.id);
      if (item?.file) send("openFolder", { path: item.file });
    });
  });

  container.querySelectorAll(".open-file-orphan").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = decodeURIComponent(btn.dataset.path || "");
      if (path) send("openFile", { path });
    });
  });

  container.querySelectorAll(".open-folder-orphan").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = decodeURIComponent(btn.dataset.path || "");
      if (path) send("openFolder", { path });
    });
  });

  container.querySelectorAll(".redownload-one").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = history.find((h) => h.id === btn.dataset.id);
      const force = Boolean(item?.fileOnDisk || item?.status === "done");
      await downloadIds([btn.dataset.id], { force });
    });
  });

  container.querySelectorAll(".open-page-url").forEach((btn) => {
    btn.addEventListener("click", () => {
      const url = decodeURIComponent(btn.dataset.url || "");
      if (url) chrome.tabs.create({ url });
    });
  });
}

async function render() {
  updateOverallProgress();
  updateStatsGrid();

  if (sidebarPage === "settings") return;

  if (sidebarPage === "downloads") {
    await renderDownloads();
    return;
  }

  await syncActiveTab();

  const list = filteredList();
  const container = listEl();
  if (!container) return;

  const restoreScroll = preserveListScroll(container);
  const groups = groupByPage(list);

  updateVideosHints();

  if (!list.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>${searchQuery ? "No matches" : videosTab === "current" ? "Nothing on this page" : "No videos yet"}</strong>
        ${
          searchQuery
            ? "Try another search term."
            : videosTab === "current"
              ? "Play a video on the active tab — streams appear here automatically."
              : "Play videos on any site — they are grouped here by page URL."
        }
      </div>`;
    syncSelectAll();
    updateDownloadButton();
    restoreScroll();
    return;
  }

  captureVideoCardOpenState(container);
  capturePageGroupOpenState(container);

  if (videosTab === "current") {
    container.innerHTML =
      currentPageBannerHtml() + list.map((item) => videoCardHtml(item, { compact: false })).join("");
  } else {
    container.innerHTML = groups.map((g) => pageGroupHtml(g)).join("");
  }

  bindVideoListEvents(container);
  bindVideoRenameEvents(container);
  refreshVideoTitleInputs(container);
  bindPageGroupToggle(container);
<<<<<<< Updated upstream
  requestThumbnailsForList(list);
=======
  bindPageFolderEvents(container);
  refreshPageFolderInputs(container);
  autoSelectReadyItems();
>>>>>>> Stashed changes
  syncSelectAll();
  updateDownloadButton();
  restoreScroll();
  lastHistoryFingerprint = historyFingerprint(history);
  lastStructureFingerprint = historyStructureFingerprint(history);
  lastProgressFingerprint = historyProgressFingerprint(history);
}

function syncOneSelectAll(el, list) {
  if (!el) return;
  el.disabled = list.length === 0;
  const n = list.filter((h) => selected.has(h.id)).length;
  el.checked = list.length > 0 && n === list.length;
  el.indeterminate = n > 0 && n < list.length;
}

function syncSelectAll() {
  syncOneSelectAll($("#selectAllVisited"), selectableItems(history));
  const onPage = history.filter((h) => samePage(h.pageUrl, activeTabUrl));
  syncOneSelectAll($("#selectAllCurrent"), selectableItems(onPage));
}

function applyHistoryDataInner(h, { renderIfChanged = true } = {}) {
  const fp = historyFingerprint(h);
  const structFp = historyStructureFingerprint(h);
  const progressFp = historyProgressFingerprint(h);
  history = h || [];
  pruneSelection();

  if (!renderIfChanged) return;

  const structureChanged = structFp !== lastStructureFingerprint;
  const progressChanged = progressFp !== lastProgressFingerprint;
  const historyChanged = fp !== lastHistoryFingerprint;

  if (structureChanged) {
    lastStructureFingerprint = structFp;
    lastHistoryFingerprint = fp;
    lastProgressFingerprint = progressFp;
    scheduleRender();
    return;
  }

  if (historyChanged) {
    lastHistoryFingerprint = fp;
    lastProgressFingerprint = progressFp;
    const touchTimeline = progressChanged;
    const touchQuality = structureChanged;
    if (sidebarPage === "videos" && !uiLocked) {
      if (!patchVideoListsUi({ touchTimeline, touchQuality })) scheduleRender();
      else updateSelectionUi();
    } else if (sidebarPage === "downloads" && !uiLocked) {
      scheduleRender();
    } else if (sidebarPage === "settings") {
      updateStatsGrid();
      updateOverallProgress();
    }
  }
}

function applyHistoryData(h, opts = { renderIfChanged: true }) {
  pendingHistoryApply = h;
  pendingHistoryOpts = opts;
  if (historyApplyScheduled) return;
  historyApplyScheduled = true;
  requestAnimationFrame(() => {
    historyApplyScheduled = false;
    const data = pendingHistoryApply;
    const applyOpts = pendingHistoryOpts;
    pendingHistoryApply = null;
    pendingHistoryOpts = { renderIfChanged: true };
    if (data != null) applyHistoryDataInner(data, applyOpts);
  });
}

async function refresh({ fullRender = true } = {}) {
  const prevUrl = activeTabUrl;
  const [h, url] = await Promise.all([
    send("getHistory").then((r) => r.history || []),
    syncActiveTab(),
  ]);
  const urlChanged = url && url !== prevUrl;

  if (fullRender) {
    history = h || [];
    lastHistoryFingerprint = historyFingerprint(history);
    lastStructureFingerprint = historyStructureFingerprint(history);
    lastProgressFingerprint = historyProgressFingerprint(history);
    await render();
    return;
  }

  applyHistoryData(h, { renderIfChanged: true });
  if (urlChanged && !uiLocked) {
    if (sidebarPage === "videos" && videosTab === "current") scheduleRender();
    else if (sidebarPage === "videos") {
      updateCurrentPageHighlight();
      updateVideosHints();
      if (!patchVideoListContainer($("#videoListCurrent"), "current", { touchTimeline: false, touchQuality: false })) {
        scheduleRender();
      }
    }
  }
}

async function refreshSoft() {
  if (uiLocked) return;
  const prev = activeTabUrl;
  await syncActiveTab();
  if (activeTabUrl !== prev) {
    if (sidebarPage === "videos" && videosTab === "current") scheduleRender();
    else if (sidebarPage === "videos") {
      updateCurrentPageHighlight();
      updateVideosHints();
      if (!patchVideoListContainer($("#videoListCurrent"), "current", { touchTimeline: false, touchQuality: false })) {
        scheduleRender();
      }
    }
  }
}

async function downloadIds(ids, { force = false } = {}) {
  const outputDir = $("#outputDir")?.value.trim();
  if (!outputDir) {
    await setPage("settings");
    $("#outputDir")?.focus();
    return;
  }
  await send("setSettings", { settings: { outputDir } });
  const res = await send("downloadItems", { ids, force });
  if (!res?.ok) return;
  await refresh();
}

async function setPage(mode) {
  if (mode === "all" || mode === "visited") {
    sidebarPage = "videos";
    videosTab = "all";
  } else if (mode === "current") {
    sidebarPage = "videos";
    videosTab = "current";
  } else {
    sidebarPage = mode === "downloads" ? "downloads" : mode === "settings" ? "settings" : "videos";
  }

  applyPageVisibility();

  await send("setSettings", {
    settings: {
      sidebarPage,
      videosTab,
      activePage: sidebarPage,
      filterMode: sidebarPage === "videos" ? videosTab : sidebarPage,
    },
  });

  if (sidebarPage === "downloads") {
    await send("syncDownloads");
    updateStatsGrid();
    updateOverallProgress();
    await renderDownloads();
  } else if (sidebarPage === "videos") {
    await syncActiveTab();
    await render();
  } else {
    updateStatsGrid();
    updateOverallProgress();
  }
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => setPage(btn.dataset.nav));
});

document.querySelectorAll(".inner-tab").forEach((btn) => {
  btn.addEventListener("click", () => setVideosTab(btn.dataset.tab));
});

$("#openFolderBtn").addEventListener("click", async () => {
  const { settings } = await send("getSettings");
  await send("openFolder", { outputDir: settings?.outputDir });
});

$("#verifyFilesBtn").addEventListener("click", async () => {
  await send("syncDownloads");
  await refresh({ fullRender: true });
});

let downloadsSyncTimer = null;
function startDownloadsSyncLoop() {
  clearInterval(downloadsSyncTimer);
  downloadsSyncTimer = setInterval(async () => {
    if (document.hidden || sidebarPage !== "downloads" || uiLocked) return;
    await send("syncDownloads");
    scheduleRender();
  }, 15000);
}

$("#searchInputVisited")?.addEventListener("input", (e) => {
  searchQuery = e.target.value;
  if (sidebarPage === "videos" && videosTab === "all") scheduleRender();
});

function clearSelection(scope) {
  const onPage = scope === "current";
  const list = onPage
    ? history.filter((h) => samePage(h.pageUrl, activeTabUrl))
    : history;
  for (const h of list) selected.delete(h.id);
  persistSelection();
  updateSelectionUi();
  updateDownloadButton();
  syncSelectAll();
}

document.querySelectorAll(".select-all-cb").forEach((el) => {
  el.addEventListener("change", () => {
    const onPage = el.id === "selectAllCurrent";
    const list = onPage
      ? selectableItems(history.filter((h) => samePage(h.pageUrl, activeTabUrl)))
      : selectableItems(history);
    if (el.checked) list.forEach((h) => selected.add(h.id));
    else list.forEach((h) => selected.delete(h.id));
    persistSelection();
    updateSelectionUi();
    updateDownloadButton();
  });
});

$("#clearSelectionVisited")?.addEventListener("click", () => clearSelection("visited"));
$("#clearSelectionCurrent")?.addEventListener("click", () => clearSelection("current"));

document.querySelectorAll(".btn-download-selected").forEach((btn) => {
  btn.addEventListener("click", () => {
    const ids = [...selected].filter((id) => isBulkSelectable(history.find((h) => h.id === id)));
    downloadIds(ids);
  });
});

$("#refreshBtn").addEventListener("click", async () => {
  await send("refreshCurrentTab");
  await refresh();
});

document.querySelectorAll(".cards-expand-all").forEach((btn) => {
  btn.addEventListener("click", () => {
    const container = btn.dataset.scope === "current" ? $("#videoListCurrent") : $("#videoListVisited");
    const list =
      btn.dataset.scope === "current"
        ? history.filter((h) => samePage(h.pageUrl, activeTabUrl))
        : filteredList();
    setAllVideoCardsExpanded(container, true, list);
  });
});

document.querySelectorAll(".cards-collapse-all").forEach((btn) => {
  btn.addEventListener("click", () => {
    const container = btn.dataset.scope === "current" ? $("#videoListCurrent") : $("#videoListVisited");
    const list =
      btn.dataset.scope === "current"
        ? history.filter((h) => samePage(h.pageUrl, activeTabUrl))
        : filteredList();
    setAllVideoCardsExpanded(container, false, list);
  });
});

function readSettingsForm() {
  return {
    outputDir: $("#outputDir")?.value.trim() || "",
    qualityPreference: $("#qualityPreference")?.value || "best",
  };
}

$("#saveSettings").addEventListener("click", async () => {
  await send("setSettings", { settings: readSettingsForm() });
  await send("applyQualityPreference");
  await refresh({ fullRender: true });
});

$("#clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("Clear all video history?")) return;
  selectedVisited.clear();
  selectedCurrent.clear();
  pageFolderCache.clear();
  await persistSelection();
  await send("clearHistory");
  await refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[HISTORY_KEY]) return;
  applyHistoryData(changes[HISTORY_KEY].newValue || []);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "tabPageChanged" && msg.url) {
    activeTabUrl = msg.url;
    if (sidebarPage === "videos" && videosTab === "current") scheduleRender();
    else if (sidebarPage === "videos") {
      updateCurrentPageHighlight();
      updateVideosHints();
      if (!patchVideoListContainer($("#videoListCurrent"), "current", { touchTimeline: false, touchQuality: false })) {
        scheduleRender();
      }
    }
  }
  if (msg.type === "historyUpdated") {
    applyHistoryData(msg.history || []);
  }
  if (msg.type === "downloadProgress") applyProgressToRow(msg.id, msg.progress, msg.progressLabel);
  if (msg.type === "bulkDownloadProgress") {
    bulkProgress = {
      batchId: msg.batchId,
      total: msg.total,
      done: msg.done,
      queued: msg.queued,
      overallPercent: msg.overallPercent,
      currentId: msg.currentId,
      currentTitle: msg.currentTitle,
      currentProgress: msg.currentProgress,
      currentLabel: msg.currentLabel,
    };
    updateOverallProgress();
  }
});

function startRefreshLoop() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden) refreshSoft();
  }, 2000);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh({ fullRender: false });
});

async function checkHost() {
  const el = $("#hostStatus");
  if (!el) return;
  const res = await send("pingHost");
  if (res?.ok) {
    setText(el, res.ffmpeg && res.ffmpeg !== "not found" ? "ffmpeg OK" : "Helper OK");
    el.className = "badge badge-ok";
  } else {
    setText(el, "No helper");
    el.className = "badge badge-err";
  }
}

(async () => {
  setupUiLock();
  const { settings } = await send("getSettings");
  if (settings?.outputDir) $("#outputDir").value = settings.outputDir;
  const qualityPref = settings?.qualityPreference || "best";
  const qualityEl = $("#qualityPreference");
  if (qualityEl) qualityEl.value = qualityPref;
  sidebarPage = settings?.sidebarPage || settings?.activePage || "videos";
  if (sidebarPage === "all" || sidebarPage === "visited" || sidebarPage === "current") {
    videosTab = sidebarPage === "current" ? "current" : "all";
    sidebarPage = "videos";
  } else {
    videosTab = settings?.videosTab || settings?.filterMode || "all";
    if (videosTab !== "all" && videosTab !== "current") videosTab = "all";
  }
  checkHost();
  await send("refreshCurrentTab");
  applyPageVisibility();
  await refresh({ fullRender: true });
  const migration = await chrome.storage.local.get(SELECTION_RESET_KEY);
  if (!migration[SELECTION_RESET_KEY]) {
    selected.clear();
    await persistSelection();
    await chrome.storage.local.set({ [SELECTION_RESET_KEY]: true });
  } else {
    await loadSelection();
  }
  pruneSelection();
  updateDownloadButton();
  updateSelectionUi();
  await send("setSettings", {
    settings: {
      sidebarPage,
      videosTab,
      activePage: sidebarPage,
      filterMode: sidebarPage === "videos" ? videosTab : sidebarPage,
    },
  });
  if (sidebarPage === "downloads") {
    await send("syncDownloads");
    await renderDownloads();
  }
  startRefreshLoop();
  startDownloadsSyncLoop();
})();
