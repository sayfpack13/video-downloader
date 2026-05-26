const $ = (sel) => document.querySelector(sel);
const HISTORY_KEY = "videoHistory";

let history = [];
let activeTabUrl = "";
let filterMode = "all"; // all | current | downloads
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
    card.classList.toggle("is-selected", selected.has(id));
    const cb = card.querySelector(".row-check");
    if (cb && !cb.disabled) cb.checked = selected.has(id);
  });
  syncSelectAll();
  updateDownloadButton();
}

function patchVisitedListUi() {
  const list = filteredList();
  const groups = groupByPage(list);
  const container = $("#videoList");
  if (!container || filterMode === "downloads") return false;

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
        filterMode === "current"
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
    card.classList.toggle("is-selected", selected.has(item.id));

    const dlBtn = card.querySelector(".dl-one");
    if (dlBtn) {
      const canDownload =
        (item.m3u8Url || item.qualities?.length) &&
        !item.qualitiesLoading &&
        item.status !== "done" &&
        item.status !== "downloading";
      dlBtn.disabled = !canDownload;
    }
  }

  for (const group of groups) {
    const key = encodeURIComponent(group.key);
    const details = container.querySelector(`details.page-group[data-page-key="${key}"]`);
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

  if (filterMode === "all") {
    const hint = $("#hint");
    hint.textContent = searchQuery
      ? `${list.length} match · ${groups.length} page${groups.length === 1 ? "" : "s"}`
      : `${list.length} videos · ${groups.length} page${groups.length === 1 ? "" : "s"} visited`;
  }

  updateStatsGrid();
  updateDownloadButton();
  updateOverallProgress();
  return true;
}

function isReady(item) {
  return (
    (item.m3u8Url || item.qualities?.length) &&
    !item.qualitiesLoading &&
    item.status !== "done" &&
    item.status !== "downloading"
  );
}

async function persistSelection() {
  await send("saveSelection", { ids: [...selected] });
}

async function loadSelection() {
  const { ids } = await send("loadSelection");
  selected.clear();
  (ids || []).forEach((id) => selected.add(id));
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
    if (isReady(item) && !selected.has(item.id)) {
      selected.add(item.id);
      added = true;
    }
  }
  if (added) persistSelection();
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
  container.querySelectorAll("details.page-group[data-page-key]").forEach((el) => {
    el.addEventListener("toggle", () => {
      const key = decodeURIComponent(el.dataset.pageKey || "");
      if (key) pageGroupOpenState.set(key, el.open);
    });
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
  const selectable = group.items.filter((i) => i.status !== "done");
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

function updateControlsVisibility() {
  const isDownloads = filterMode === "downloads";
  $(".action-row")?.classList.toggle("hidden", isDownloads);
  $("#downloadSelectedBtn")?.classList.toggle("hidden", isDownloads);
  $(".search-row")?.classList.toggle("hidden", isDownloads);
  $("#downloadsToolbar")?.classList.toggle("hidden", !isDownloads);
}

function filteredList() {
  if (filterMode === "downloads") {
    return history
      .filter((h) => h.downloadedAt || h.status === "done" || h.file)
      .sort((a, b) => (b.downloadedAt || b.lastSeen || 0) - (a.downloadedAt || a.lastSeen || 0));
  }
  const page = normalizePageUrl(activeTabUrl);
  let list =
    filterMode === "current"
      ? history.filter((h) => samePage(h.pageUrl, page))
      : history;
  if (searchQuery.trim()) {
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

function updateStatsGrid() {
  const scope =
    filterMode === "current"
      ? history.filter((h) => samePage(h.pageUrl, activeTabUrl))
      : filterMode === "downloads"
        ? history.filter((h) => h.downloadedAt || h.status === "done" || h.file)
        : history;
  $("#statTotal").textContent = scope.length;
  $("#statReady").textContent = scope.filter(isReady).length;
  $("#statWait").textContent = scope.filter(
    (h) =>
      !isReady(h) &&
      h.status !== "done" &&
      h.status !== "downloading" &&
      (h.m3u8Url || h.qualitiesLoading)
  ).length;
  $("#statDone").textContent = scope.filter((h) => h.status === "done").length;
}

function updateDownloadButton() {
  const downloadable = [...selected].filter((id) => {
    const item = history.find((h) => h.id === id);
    return item?.m3u8Url && !item.qualitiesLoading && item.status !== "done" && item.status !== "downloading";
  });
  const btn = $("#downloadSelectedBtn");
  btn.textContent = `Download selected (${downloadable.length})`;
  btn.disabled = downloadable.length === 0;
}

function updateOverallProgress() {
  const downloading = history.filter((h) => h.status === "downloading");
  const box = $("#overallProgress");
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
  $("#overallLabel").textContent = label;
  const bar = $("#overallBar");
  if (avg < 0) {
    bar.className = "timeline-fill indeterminate";
    bar.style.width = "35%";
    $("#overallPercent").textContent = totalDur ? formatDuration(totalDur) + " total" : "";
  } else {
    bar.className = "timeline-fill timeline-fill-active";
    bar.style.width = `${avg}%`;
    $("#overallPercent").textContent = `${avg}%`;
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
  const container = $("#videoList");
  const restoreScroll = preserveListScroll(container);
  const hint = $("#hint");
  updateControlsVisibility();

  const sync = await loadDownloadsView();
  const doneItems = filteredList();
  const groups = groupByPage(doneItems);
  capturePageGroupOpenState(container);

  const onDiskCount = doneItems.filter((h) => h.fileOnDisk === true).length;
  const missingCount = doneItems.filter((h) => h.downloadedAt && h.fileOnDisk !== true).length;
  const pageCount = groups.length;
  hint.textContent = `${onDiskCount} on disk · ${missingCount} missing · ${pageCount} page${pageCount === 1 ? "" : "s"}`;
  if (sync?.linked) hint.textContent += ` · ${sync.linked} linked`;

  if (!doneItems.length && !diskFiles.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>No downloads yet</strong>
        Download videos from the Visited tab — they will appear here grouped by page.
      </div>`;
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
          <div class="page-group-actions" onclick="event.stopPropagation()">
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
  const checked = selected.has(item.id) ? "checked" : "";
  const isCurrent = samePage(item.pageUrl, activeTabUrl) ? "is-current" : "";
  const isSel = selected.has(item.id) ? "is-selected" : "";
  const canDownload =
    (item.m3u8Url || item.qualities?.length) &&
    !item.qualitiesLoading &&
    item.status !== "done" &&
    item.status !== "downloading";
  const pill = statusPill(item);
  const meta = compact
    ? formatTime(item.lastSeen)
    : `${escapeHtml(shortPath(item.pageUrl))} · ${formatTime(item.lastSeen)}`;
  return `
    <article class="video-card ${compact ? "compact" : ""} ${isCurrent} ${isSel}" data-id="${item.id}">
      <div class="card-check">
        <input type="checkbox" class="row-check" data-id="${item.id}" ${checked}
          ${item.status === "done" ? "disabled" : ""} />
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
        <div class="page-group-actions" onclick="event.stopPropagation()">
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
      if (cb.checked) selected.add(cb.dataset.id);
      else selected.delete(cb.dataset.id);
      syncSelectAll();
      updateDownloadButton();
      persistSelection();
      updateSelectionUi();
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
        if (item.status === "done") continue;
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
  updateControlsVisibility();

  if (filterMode === "downloads") {
    updateStatsGrid();
    await renderDownloads();
    updateOverallProgress();
    return;
  }

  await syncActiveTab();

  const list = filteredList();
  const container = $("#videoList");
  const restoreScroll = preserveListScroll(container);
  const hint = $("#hint");

  const groups = groupByPage(list);

  if (filterMode === "current") {
    const pageLabel = pageHostname(activeTabUrl) || "this page";
    hint.textContent = list.length
      ? `${list.length} video${list.length === 1 ? "" : "s"} on ${pageLabel}`
      : `No streams on this page — play a video to detect it.`;
  } else {
    hint.textContent = searchQuery
      ? `${list.length} match · ${groups.length} page${groups.length === 1 ? "" : "s"}`
      : `${list.length} videos · ${groups.length} page${groups.length === 1 ? "" : "s"} visited`;
  }

  updateStatsGrid();

  if (!list.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>${searchQuery ? "No matches" : filterMode === "current" ? "Nothing on this page" : "No videos yet"}</strong>
        ${
          searchQuery
            ? "Try another search term."
            : filterMode === "current"
              ? "Play a video on the active tab — streams appear here automatically."
              : "Play videos on any site — they are grouped here by page URL."
        }
      </div>`;
    $("#selectAll").checked = false;
    updateDownloadButton();
    updateOverallProgress();
    return;
  }

  capturePageGroupOpenState(container);

  if (filterMode === "current") {
    container.innerHTML =
      currentPageBannerHtml() + list.map((item) => videoCardHtml(item, { compact: false })).join("");
  } else {
    container.innerHTML = groups.map((g) => pageGroupHtml(g)).join("");
  }

  bindVideoListEvents(container);
  bindPageGroupToggle(container);
  syncSelectAll();
  updateDownloadButton();
  updateOverallProgress();
  restoreScroll();
  lastHistoryFingerprint = historyFingerprint(history);
  lastStructureFingerprint = historyStructureFingerprint(history);
}

function syncSelectAll() {
  const list = filteredList().filter((h) => h.status !== "done");
  $("#selectAll").checked = list.length > 0 && list.every((h) => selected.has(h.id));
}

function applyHistoryData(h, { renderIfChanged = true } = {}) {
  const fp = historyFingerprint(h);
  const structFp = historyStructureFingerprint(h);
  const prevReady = new Set(history.filter(isReady).map((x) => x.id));
  history = h || [];
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
    if (filterMode === "current") {
      scheduleRender();
      return;
    }
    if (filterMode === "all" && !uiLocked) {
      if (!patchVisitedListUi()) scheduleRender();
      else updateSelectionUi();
    } else if (filterMode === "downloads" && !uiLocked) {
      scheduleRender();
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
    if (filterMode === "current") scheduleRender();
    else updateCurrentPageHighlight();
  }
}

async function refreshSoft() {
  if (uiLocked) return;
  const prev = activeTabUrl;
  await syncActiveTab();
  if (activeTabUrl !== prev) {
    if (filterMode === "current") scheduleRender();
    else updateCurrentPageHighlight();
  }
}

async function downloadIds(ids, { force = false } = {}) {
  const outputDir = $("#outputDir").value.trim();
  if (!outputDir) {
    $("#outputDir").focus();
    return;
  }
  await send("setSettings", { settings: { outputDir } });
  const res = await send("downloadItems", { ids, force });
  if (!res?.ok) return;
  await refresh();
}

async function setFilter(mode) {
  filterMode = mode === "current" ? "current" : mode === "downloads" ? "downloads" : "all";
  document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
  const map = { all: "#filterAll", current: "#filterCurrent", downloads: "#filterDownloads" };
  $(map[filterMode])?.classList.add("active");
  await send("setSettings", { settings: { filterMode } });
  if (filterMode === "downloads") {
    await send("syncDownloads");
    await refresh({ fullRender: true });
  } else {
    await syncActiveTab();
    await render();
  }
}

$("#filterCurrent").addEventListener("click", () => setFilter("current"));
$("#filterAll").addEventListener("click", () => setFilter("all"));
$("#filterDownloads").addEventListener("click", () => setFilter("downloads"));

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
    if (document.hidden || filterMode !== "downloads" || uiLocked) return;
    await send("syncDownloads");
    scheduleRender();
  }, 15000);
}

$("#searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value;
  scheduleRender();
});

$("#selectAll").addEventListener("change", () => {
  const list = filteredList().filter((h) => h.status !== "done");
  if ($("#selectAll").checked) list.forEach((h) => selected.add(h.id));
  else list.forEach((h) => selected.delete(h.id));
  persistSelection();
  render();
});

$("#downloadSelectedBtn").addEventListener("click", () => {
  const ids = [...selected].filter((id) => {
    const item = history.find((h) => h.id === id);
    return item?.m3u8Url && !item.qualitiesLoading && item.status !== "done";
  });
  downloadIds(ids);
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
    if (filterMode === "current") scheduleRender(true);
    else updateCurrentPageHighlight();
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
  const res = await send("pingHost");
  if (res?.ok) {
    el.textContent = res.ffmpeg && res.ffmpeg !== "not found" ? "ffmpeg OK" : "Helper OK";
    el.className = "badge badge-ok";
  } else {
    el.textContent = "No helper";
    el.className = "badge badge-err";
  }
}

(async () => {
  setupUiLock();
  const { settings } = await send("getSettings");
  if (settings?.outputDir) $("#outputDir").value = settings.outputDir;
  if (settings?.filterMode) {
    const m = settings.filterMode;
    await setFilter(m === "current" ? "current" : m === "downloads" ? "downloads" : "all");
  }
  await loadSelection();
  checkHost();
  await send("refreshCurrentTab");
  await refresh({ fullRender: true });
  autoSelectReadyItems();
  startRefreshLoop();
  startDownloadsSyncLoop();
})();
