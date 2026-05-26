const $ = (sel) => document.querySelector(sel);
const HISTORY_KEY = "videoHistory";

let history = [];
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
  applyPageVisibility();
  await send("setSettings", {
    settings: { sidebarPage: "videos", videosTab, activePage: "videos", filterMode: videosTab },
  });
  await syncActiveTab();
  await render();
}
let searchQuery = "";
let diskFiles = [];
const selected = new Set();
let renderScheduled = false;
let refreshTimer = null;
let uiLocked = false;
let pendingRender = false;
let lastHistoryFingerprint = "";
let lastStructureFingerprint = "";
/** @type {Map<string, boolean>} user expand/collapse per page key */
const pageGroupOpenState = new Map();

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
  return (h || [])
    .map(
      (i) =>
        `${i.id}:${i.status}:${i.qualitiesLoading}:${i.durationLoading}:${i.duration}:${i.selectedQualityIndex}:${i.m3u8Url}:${i.qualities?.length}:${(i.title || "").slice(0, 40)}`
    )
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

function setupUiLock() {
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.target.closest(".quality-select")) uiLocked = true;
    },
    true
  );
  document.addEventListener("focusin", (e) => {
    if (e.target.closest(".quality-select")) uiLocked = true;
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.closest(".quality-select")) {
      setTimeout(unlockUi, 250);
    }
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

function patchVisitedListUi() {
  if (sidebarPage !== "videos") return false;
  const list = filteredList();
  const groups = groupByPage(list);
  const container = listEl();
  if (!container) return false;

  for (const item of list) {
    const card = container.querySelector(`.video-card[data-id="${item.id}"]`);
    if (!card) return false;

    const pill = statusPill(item);
    const pillEl = card.querySelector(".status-pill");
    if (pillEl) {
      pillEl.className = `status-pill ${pill.cls}`;
      pillEl.textContent = pill.text;
    }

    const timeline = card.querySelector(".timeline-block");
    if (timeline) timeline.outerHTML = timelineHtml(item);

    const meta = card.querySelector(".card-meta");
    if (meta) {
      meta.textContent =
        videosTab === "current"
          ? formatTime(item.lastSeen)
          : `${shortPath(item.pageUrl)} · ${formatTime(item.lastSeen)}`;
    }

    const qWrap = card.querySelector(".quality-inline");
    const qHtml = qualityHtml(item);
    if (qHtml && !qWrap) {
      const actions = card.querySelector(".card-actions");
      if (actions) actions.insertAdjacentHTML("beforebegin", qHtml);
    } else if (qHtml && qWrap) {
      qWrap.outerHTML = qHtml;
    } else if (!qHtml && qWrap) {
      qWrap.remove();
    }

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
  }

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
    }
  }

  if (hint) {
    setText(
      hint,
      searchQuery
        ? `${list.length} match · ${groups.length} page${groups.length === 1 ? "" : "s"}`
        : `${list.length} videos · ${groups.length} page${groups.length === 1 ? "" : "s"} visited`
    );
  }

  updateStatsGrid();
  updateDownloadButton();
  updateOverallProgress();
  return true;
}

function isReady(item) {
  return (
    hasStream(item) &&
    !item.qualitiesLoading &&
    item.status !== "done" &&
    item.status !== "downloading"
  );
}

function hasStream(item) {
  return Boolean(item?.m3u8Url || item?.masterM3u8Url || item?.qualities?.length);
}

/** Eligible for bulk select / “Download selected” (excludes saved-on-disk items) */
function isBulkSelectable(item) {
  if (!item) return false;
  if (item.status === "done" || item.status === "downloading") return false;
  if (item.fileOnDisk === true && item.file) return false;
  return hasStream(item) && !item.qualitiesLoading;
}

function selectableItems(list = filteredList()) {
  return list.filter(isBulkSelectable);
}

function pruneSelection() {
  let changed = false;
  for (const id of [...selected]) {
    const item = history.find((h) => h.id === id);
    if (!isBulkSelectable(item)) {
      selected.delete(id);
      changed = true;
    }
  }
  return changed;
}

async function persistSelection() {
  pruneSelection();
  await send("saveSelection", { ids: [...selected] });
}

async function loadSelection() {
  const { ids } = await send("loadSelection");
  selected.clear();
  for (const id of ids || []) {
    const item = history.find((h) => h.id === id);
    if (!item || isBulkSelectable(item)) selected.add(id);
  }
  pruneSelection();
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

function autoSelectReadyItems() {
  let added = false;
  for (const item of history) {
    if (isBulkSelectable(item) && !selected.has(item.id)) {
      selected.add(item.id);
      added = true;
    }
  }
  if (added) {
    persistSelection();
    updateDownloadButton();
    updateSelectionUi();
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

function samePage(a, b) {
  if (!a || !b) return false;
  return normalizePageUrl(a) === normalizePageUrl(b);
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
  if (group.items.some((i) => i.status === "downloading")) return true;
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
  if (dl) return `${dl} downloading`;
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

  if (item.status === "downloading") {
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

function chipsHtml(item) {
  const info = item.streamInfo;
  if (!info && !item.m3u8Url) return "";

  const chips = [];
  if (info?.maxQuality) {
    const q =
      info.qualityCount > 1 ? `${info.maxQuality} +${info.qualityCount - 1}` : info.maxQuality;
    chips.push(`<span class="chip chip-q">${escapeHtml(q)}</span>`);
  }
  if (info?.streamId) chips.push(`<span class="chip">ID ${escapeHtml(info.streamId)}</span>`);
  if (info?.cdnHost) chips.push(`<span class="chip">${escapeHtml(info.cdnHost)}</span>`);
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
  const disabled = item.status === "downloading" || item.status === "done" ? "disabled" : "";
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

function filteredList() {
  if (sidebarPage === "downloads") {
    return history
      .filter((h) => h.downloadedAt || h.status === "done" || h.file)
      .sort((a, b) => (b.downloadedAt || b.lastSeen || 0) - (a.downloadedAt || a.lastSeen || 0));
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
        (h.pageUrl || "").toLowerCase().includes(q) ||
        (h.streamInfo?.streamId || "").toLowerCase().includes(q)
    );
  }
  return list;
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

function updateOverallProgress() {
  const downloading = history.filter((h) => h.status === "downloading");
  const box = $("#overallProgress");
  if (!box) return;
  if (!downloading.length) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const withPct = downloading.filter((h) => h.progress >= 0);
  let avg = withPct.length ? Math.round(withPct.reduce((s, h) => s + h.progress, 0) / withPct.length) : -1;
  const totalDur = downloading.reduce((s, h) => s + (itemDuration(h) || 0), 0);
  const label =
    downloading.length === 1
      ? downloading[0].title
      : `Downloading ${downloading.length} videos`;
  setText($("#overallLabel"), label);
  const bar = $("#overallBar");
  if (!bar) return;
  if (avg < 0) {
    bar.className = "timeline-fill indeterminate";
    bar.style.width = "35%";
    setText($("#overallPercent"), totalDur ? formatDuration(totalDur) + " total" : "");
  } else {
    bar.className = "timeline-fill timeline-fill-active";
    bar.style.width = `${avg}%`;
    setText($("#overallPercent"), `${avg}%`);
  }
}

function applyProgressToRow(id, progress, progressLabel) {
  const item = history.find((h) => h.id === id);
  if (item) {
    item.progress = progress;
    item.progressLabel = progressLabel;
  }
  const block = document.querySelector(`[data-timeline-id="${id}"]`);
  if (block && item) {
    block.outerHTML = timelineHtml(item);
  }
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

function videoCardHtml(item, { compact = false } = {}) {
  const bulkOk = isBulkSelectable(item);
  const checked = bulkOk && selected.has(item.id) ? "checked" : "";
  const isCurrent = samePage(item.pageUrl, activeTabUrl) ? "is-current" : "";
  const isSel = bulkOk && selected.has(item.id) ? "is-selected" : "";
  const canDownload = bulkOk;
  const pill = statusPill(item);
  const meta = compact
    ? formatTime(item.lastSeen)
    : `${escapeHtml(shortPath(item.pageUrl))} · ${formatTime(item.lastSeen)}`;
  return `
    <article class="video-card ${compact ? "compact" : ""} ${isCurrent} ${isSel}" data-id="${item.id}">
      <div class="card-check">
        <input type="checkbox" class="row-check" data-id="${item.id}" ${checked}
          ${bulkOk ? "" : "disabled"} />
      </div>
      <div class="card-body">
        <div class="card-head">
          <h3 class="card-title">${escapeHtml(item.title)}</h3>
          <span class="status-pill ${pill.cls}">${pill.text}</span>
        </div>
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
    </article>`;
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
        ${group.items.map((item) => videoCardHtml(item, { compact: true })).join("")}
      </div>
    </details>`;
}

function currentPageBannerHtml() {
  if (!activeTabUrl) return "";
  return `
    <div class="page-banner is-active">
      <div class="page-banner-text">
        <span class="page-banner-host">${escapeHtml(pageHostname(activeTabUrl))}</span>
        <span class="page-banner-url" title="${escapeHtml(activeTabUrl)}">${escapeHtml(pagePathLine(activeTabUrl))}</span>
      </div>
      <div class="page-banner-actions">
        <button class="btn-action btn-sm focus-tab" type="button" title="Focus browser tab">Tab ↗</button>
      </div>
    </div>`;
}

function bindVideoListEvents(container) {
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

  container.querySelectorAll(".quality-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      uiLocked = false;
      pendingRender = false;
      await send("setQuality", { id: sel.dataset.id, index: parseInt(sel.value, 10) });
      await refresh({ fullRender: true });
    });
  });
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
  const hint = hintEl();
  if (!container || !hint) return;

  const restoreScroll = preserveListScroll(container);
  const groups = groupByPage(list);

  if (videosTab === "current") {
    const pageLabel = pageHostname(activeTabUrl) || "this page";
    setText(
      hint,
      list.length
        ? `${list.length} video${list.length === 1 ? "" : "s"} on ${pageLabel}`
        : `No streams on this page — play a video to detect it.`
    );
  } else {
    setText(
      hint,
      searchQuery
        ? `${list.length} match · ${groups.length} page${groups.length === 1 ? "" : "s"}`
        : `${list.length} videos · ${groups.length} page${groups.length === 1 ? "" : "s"} visited`
    );
  }

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

  capturePageGroupOpenState(container);

  if (videosTab === "current") {
    container.innerHTML =
      currentPageBannerHtml() + list.map((item) => videoCardHtml(item, { compact: false })).join("");
  } else {
    container.innerHTML = groups.map((g) => pageGroupHtml(g)).join("");
  }

  bindVideoListEvents(container);
  bindPageGroupToggle(container);
  autoSelectReadyItems();
  syncSelectAll();
  updateDownloadButton();
  restoreScroll();
  lastHistoryFingerprint = historyFingerprint(history);
  lastStructureFingerprint = historyStructureFingerprint(history);
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

function applyHistoryData(h, { renderIfChanged = true } = {}) {
  const fp = historyFingerprint(h);
  const structFp = historyStructureFingerprint(h);
  const prevReady = new Set(history.filter(isReady).map((x) => x.id));
  history = h || [];
  pruneSelection();
  if (history.some((x) => isReady(x) && !prevReady.has(x.id))) autoSelectReadyItems();

  if (!renderIfChanged) return;

  const structureChanged = structFp !== lastStructureFingerprint;
  const historyChanged = fp !== lastHistoryFingerprint;

  if (structureChanged) {
    lastStructureFingerprint = structFp;
    lastHistoryFingerprint = fp;
    scheduleRender();
    return;
  }

  if (historyChanged) {
    lastHistoryFingerprint = fp;
    if (sidebarPage === "videos" && !uiLocked) {
      if (!patchVisitedListUi()) scheduleRender();
      else updateSelectionUi();
    } else if (sidebarPage === "downloads" && !uiLocked) {
      scheduleRender();
    } else if (sidebarPage === "settings") {
      updateStatsGrid();
      updateOverallProgress();
    }
  }
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
    await render();
    return;
  }

  applyHistoryData(h, { renderIfChanged: true });
  if (urlChanged && !uiLocked) {
    if (sidebarPage === "videos" && videosTab === "current") scheduleRender();
    else if (sidebarPage === "videos") updateCurrentPageHighlight();
  }
}

async function refreshSoft() {
  if (uiLocked) return;
  const prev = activeTabUrl;
  await syncActiveTab();
  if (activeTabUrl !== prev) {
    if (sidebarPage === "videos" && videosTab === "current") scheduleRender();
    else if (sidebarPage === "videos") updateCurrentPageHighlight();
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

$("#saveSettings").addEventListener("click", async () => {
  await send("setSettings", { settings: { outputDir: $("#outputDir").value.trim() } });
});

$("#clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("Clear all video history?")) return;
  selected.clear();
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
    if (sidebarPage === "videos" && videosTab === "current") scheduleRender(true);
    else if (sidebarPage === "videos") updateCurrentPageHighlight();
  }
  if (msg.type === "historyUpdated") {
    applyHistoryData(msg.history || []);
  }
  if (msg.type === "downloadProgress") applyProgressToRow(msg.id, msg.progress, msg.progressLabel);
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
  await loadSelection();
  pruneSelection();
  autoSelectReadyItems();
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
