importScripts("m3u8-parser.js");

const NATIVE_HOST = "com.waelacademy.downloader";
const HISTORY_KEY = "videoHistory";
const SETTINGS_KEY = "settings";
const MAX_HISTORY = 500;

const tabStreams = new Map();
const tabIdsByPage = new Map();
const tabLastUrl = new Map();
const qualityResolvePending = new Set();
const durationResolvePending = new Set();
let historyWriteChain = Promise.resolve();

function runHistoryWrite(fn) {
  const run = historyWriteChain.then(() => fn());
  historyWriteChain = run.catch(() => {});
  return run;
}

function normalizePageUrl(url) {
  try {
    const u = new URL(url);
    // Keep full hash (path + query) — lesson ids often live in hash or query
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

function videoIdFromM3u8(m3u8Url) {
  if (!m3u8Url) return null;
  const prefix = M3U8Parser.videoFolderPrefix(m3u8Url);
  return prefix || m3u8Url;
}

function buildStreamInfo(item) {
  const m3u8Url = item.m3u8Url || item.masterM3u8Url;
  if (!m3u8Url) return null;

  const qualities = item.qualities || [];
  const labels = qualities.map((q) => q.label).filter(Boolean);
  let cdnHost = "";
  try {
    cdnHost = new URL(m3u8Url).hostname.replace(/^vz-/, "");
  } catch (_) {
    /* ignore */
  }

  return {
    streamId: M3U8Parser.shortStreamId(m3u8Url),
    cdnHost,
    qualityLabels: labels,
    qualityCount: qualities.length,
    maxQuality: labels[0] || "",
    candidateCount: item.m3u8Candidates?.length || 0,
    detectedAt: item.detectedAt || null,
    duration: item.duration || null,
    durationLabel: M3U8Parser.formatDuration(item.duration),
  };
}

function applyDuration(item, seconds) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return;
  const sec = Math.round(seconds);
  if (!item.duration || sec > item.duration) item.duration = sec;
}

function attachStreamInfo(item) {
  if (!item.m3u8Url && !item.masterM3u8Url) {
    item.streamInfo = null;
    return;
  }
  item.streamInfo = buildStreamInfo(item);
}

function historyDedupeKey(item) {
  const page = normalizePageUrl(item.pageUrl);
  const vid = item.videoId || videoIdFromM3u8(item.m3u8Url || item.masterM3u8Url);
  if (vid) return `vid:${vid}|${page}`;
  return `page:${page}`;
}

function mergeHistoryItems(a, b) {
  const score = (h) => {
    let s = 0;
    if (h.status === "done") s += 1000;
    if (h.m3u8Url) s += 100;
    if (h.qualities?.length) s += 50;
    if (!h.qualitiesLoading) s += 10;
    return s + (h.lastSeen || 0) / 1e15;
  };
  const [keep, other] = score(a) >= score(b) ? [a, b] : [b, a];
  const merged = { ...keep };

  merged.title =
    (keep.title && keep.title.length > 12 ? keep.title : null) ||
    other.title ||
    keep.title;
  merged.pageUrl = keep.pageUrl || other.pageUrl;
  merged.lastSeen = Math.max(keep.lastSeen || 0, other.lastSeen || 0);
  const vKeep = keep.visitedAt || keep.lastSeen;
  const vOther = other.visitedAt || other.lastSeen;
  merged.visitedAt = Math.min(vKeep || Infinity, vOther || Infinity);
  if (!Number.isFinite(merged.visitedAt)) merged.visitedAt = vKeep || vOther;
  merged.detectedAt = Math.max(keep.detectedAt || 0, other.detectedAt || 0) || keep.detectedAt;

  merged.videoId = keep.videoId || other.videoId;
  merged.m3u8Url = keep.m3u8Url || other.m3u8Url;
  merged.masterM3u8Url = keep.masterM3u8Url || other.masterM3u8Url;
  merged.m3u8Candidates = [
    ...new Set([...(keep.m3u8Candidates || []), ...(other.m3u8Candidates || [])]),
  ];

  if ((other.qualities?.length || 0) > (keep.qualities?.length || 0)) {
    merged.qualities = other.qualities;
    merged.selectedQualityIndex = other.selectedQualityIndex;
  }
  merged.qualitiesLoading = keep.qualitiesLoading || other.qualitiesLoading;

  if (keep.status === "done" || other.status === "done") merged.status = "done";
  else if (keep.status === "downloading" || other.status === "downloading") merged.status = "downloading";
  else if (keep.status === "queued" || other.status === "queued") merged.status = "queued";
  else if (keep.status === "error" || other.status === "error") merged.status = keep.status === "error" ? keep.status : other.status;
  else if (merged.m3u8Url && merged.qualities?.length && !merged.qualitiesLoading) merged.status = "ready";
  else if (merged.m3u8Url) merged.status = keep.status === "ready" || other.status === "ready" ? "ready" : "waiting";
  else merged.status = "waiting";

  merged.file = keep.file || other.file;
  merged.downloadedAt =
    Math.max(keep.downloadedAt || 0, other.downloadedAt || 0) || keep.downloadedAt || other.downloadedAt;
  if (keep.fileOnDisk === true || other.fileOnDisk === true) merged.fileOnDisk = true;
  else if (keep.fileOnDisk === false || other.fileOnDisk === false) merged.fileOnDisk = false;
  merged.fileSize = Math.max(keep.fileSize || 0, other.fileSize || 0) || keep.fileSize || other.fileSize;
  merged.error = keep.error || other.error;
  merged.duration = Math.max(keep.duration || 0, other.duration || 0) || null;
  merged.durationLoading = keep.durationLoading || other.durationLoading;
  attachStreamInfo(merged);
  return merged;
}

function dedupeHistory(history) {
  const groups = new Map();
  for (const item of history) {
    const key = historyDedupeKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const merged = [];
  for (const items of groups.values()) {
    let acc = items[0];
    for (let i = 1; i < items.length; i++) {
      acc = mergeHistoryItems(acc, items[i]);
    }
    attachStreamInfo(acc);
    merged.push(acc);
  }

  merged.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return merged.slice(0, MAX_HISTORY);
}

function findHistoryItem(history, pageUrl, m3u8Url) {
  const page = normalizePageUrl(pageUrl);
  const videoId = videoIdFromM3u8(m3u8Url);

  if (m3u8Url && videoId) {
    const byVideo = history.find(
      (h) => normalizePageUrl(h.pageUrl) === page && h.videoId === videoId
    );
    if (byVideo) return byVideo;
    const pending = history.find(
      (h) => normalizePageUrl(h.pageUrl) === page && !h.m3u8Url && !h.videoId
    );
    if (pending) return pending;
    return null;
  }

  if (!m3u8Url) {
    const onPage = history.filter((h) => normalizePageUrl(h.pageUrl) === page);
    const visitSlot = onPage.find((h) => !h.m3u8Url && !h.videoId);
    if (visitSlot) return visitSlot;
    return null;
  }

  return null;
}

async function onTabPageChange(tabId, pageUrl, _title) {
  if (!pageUrl || !isHttpPageUrl(pageUrl)) return;
  pageUrl = normalizePageUrl(pageUrl);

  const prev = tabId ? tabLastUrl.get(tabId) : null;
  if (tabId && prev && prev !== pageUrl) {
    await flushStreamForPage(prev, tabId);
    tabStreams.delete(tabId);
  }
  if (tabId) tabLastUrl.set(tabId, pageUrl);
  chrome.runtime
    .sendMessage({ type: "tabPageChanged", url: pageUrl })
    .catch(() => {});
}

/** Skip auth pages and course/catalog listings (no single video). */
function shouldSkipPage(url) {
  const n = normalizePageUrl(url).toLowerCase();
  if (/\/(login|register|logout|signin|signup)(\/|$|\?)/i.test(n)) return true;
  if (/\/(courses?|subjects?|catalog|library|dashboard|home)(\/|$|\?)/i.test(n) && !/\/\d+/.test(n)) {
    return true;
  }
  if (/#\/(courses?|subjects?)(\/|$)/i.test(n) && !/#\/[^/]+\/[^/]+\/\d+/i.test(n)) {
    return true;
  }
  return false;
}

async function flushStreamForPage(pageUrl, tabId) {
  const stream = tabStreams.get(tabId);
  if (!stream?.m3u8Url) return;
  const streamPage = normalizePageUrl(stream.pageUrl || pageUrl);
  await upsertVideo({
    pageUrl: streamPage,
    title: stream.title,
    m3u8Url: stream.m3u8Url,
    m3u8Candidates: stream.m3u8Candidates || stream.m3u8Urls || [],
    duration: stream.duration || null,
    tabId,
  });
}

function updateBadgeCount() {
  getHistory().then((history) => {
    const ready = history.filter(
      (h) => getSelectedM3u8(h) && h.status !== "done" && !h.qualitiesLoading
    ).length;
    chrome.action.setBadgeText({ text: ready > 0 ? String(ready) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
  });
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

function uuid() {
  return crypto.randomUUID();
}

function isHttpPageUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function originFromPageUrl(pageUrl) {
  try {
    return new URL(pageUrl).origin;
  } catch {
    return "";
  }
}

async function getHistory() {
  const data = await chrome.storage.local.get(HISTORY_KEY);
  return data[HISTORY_KEY] || [];
}

async function setHistory(history) {
  return runHistoryWrite(async () => {
    const trimmed = dedupeHistory(history);
    await chrome.storage.local.set({ [HISTORY_KEY]: trimmed });
    broadcastHistory(trimmed);
    updateBadgeCount();
  });
}

async function updateHistory(mutator) {
  return runHistoryWrite(async () => {
    const history = await getHistory();
    const result = await mutator(history);
    const trimmed = dedupeHistory(history);
    history.length = 0;
    history.push(...trimmed);
    await chrome.storage.local.set({ [HISTORY_KEY]: trimmed });
    broadcastHistory(trimmed);
    updateBadgeCount();
    return result;
  });
}

function broadcastHistory(history) {
  chrome.runtime.sendMessage({ type: "historyUpdated", history }).catch(() => {});
}

const DEFAULT_SETTINGS = {
  outputDir: "",
  qualityPreference: "best",
};

async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

function pickQualityIndexForSettings(qualities, settings) {
  const pref = settings?.qualityPreference || "best";
  return M3U8Parser.pickQualityIndex(qualities, pref);
}

function applyQualityToItem(item, settings, { preserveUrl = true } = {}) {
  if (!item?.qualities?.length) return false;
  const prevUrl = preserveUrl ? item.qualities[item.selectedQualityIndex ?? 0]?.m3u8Url : null;
  let idx = prevUrl ? item.qualities.findIndex((q) => q.m3u8Url === prevUrl) : -1;
  if (idx < 0) idx = pickQualityIndexForSettings(item.qualities, settings);
  item.selectedQualityIndex = idx;
  item.m3u8Url = item.qualities[idx].m3u8Url;
  attachStreamInfo(item);
  return true;
}

async function applyQualityPreferenceToHistory() {
  const settings = await getSettings();
  let updated = 0;
  await updateHistory((history) => {
    for (const item of history) {
      if (!item.qualities?.length || item.qualities.length < 2) continue;
      if (applyQualityToItem(item, settings, { preserveUrl: false })) updated++;
    }
  });
  return { ok: true, updated };
}

async function setSettings(settings) {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...settings } });
}

function getSelectedM3u8(item) {
  if (!item.qualities?.length) return item.m3u8Url;
  const idx = item.selectedQualityIndex ?? 0;
  return item.qualities[idx]?.m3u8Url || item.m3u8Url;
}

async function fetchPlaylistText(url, pageUrl) {
  const origin = originFromPageUrl(pageUrl) || undefined;
  const response = await fetch(url, {
    headers: {
      Referer: pageUrl,
      ...(origin ? { Origin: origin } : {}),
    },
  });
  if (!response.ok) throw new Error(`Playlist fetch failed (${response.status})`);
  return response.text();
}

async function resolveQualities(m3u8Url, pageUrl, _tabId, extraUrls = []) {
  const allUrls = [...new Set([m3u8Url, ...(extraUrls || [])].filter(Boolean))];

  const fromNetwork = M3U8Parser.qualitiesFromDetectedUrls(allUrls, m3u8Url);
  if (fromNetwork.length > 1) return fromNetwork;

  const masterUrl =
    allUrls.find((u) => /\/playlist\.m3u8/i.test(u)) ||
    allUrls.find((u) => /master/i.test(u)) ||
    m3u8Url;

  if (masterUrl) {
    try {
      const text = await fetchPlaylistText(masterUrl, pageUrl);
      if (M3U8Parser.isMasterPlaylist(text)) {
        const parsed = M3U8Parser.parseMasterPlaylist(text, masterUrl);
        if (parsed.length) return parsed;
      }
    } catch (_) {
      /* fall through */
    }
  }

  if (fromNetwork.length === 1) return fromNetwork;
  return M3U8Parser.singleQuality(m3u8Url, "Auto");
}

async function resolveAndAttachQualities(itemId, m3u8Url, pageUrl, tabId, extraUrls = []) {
  if (qualityResolvePending.has(itemId)) return;
  qualityResolvePending.add(itemId);

  const hasItem = await updateHistory((history) => {
    const item = history.find((h) => h.id === itemId);
    if (!item) return false;
    item.qualitiesLoading = true;
    return true;
  });
  if (!hasItem) {
    qualityResolvePending.delete(itemId);
    return;
  }

  try {
    const qualities = await resolveQualities(m3u8Url, pageUrl, tabId, extraUrls);
    const settings = await getSettings();
    await updateHistory((history) => {
      const it = history.find((h) => h.id === itemId);
      if (!it) return;

      const prevUrl = it.qualities?.[it.selectedQualityIndex ?? 0]?.m3u8Url;
      it.qualities = qualities;
      it.qualitiesLoading = false;
      it.masterM3u8Url = m3u8Url;

      let idx = qualities.findIndex((q) => q.m3u8Url === prevUrl);
      if (idx < 0) idx = pickQualityIndexForSettings(qualities, settings);
      it.selectedQualityIndex = idx;
      it.m3u8Url = qualities[idx].m3u8Url;
      attachStreamInfo(it);

      if (it.status !== "done" && it.status !== "downloading") {
        it.status = "ready";
      }
    });
  } catch (e) {
    await updateHistory((history) => {
      const it = history.find((h) => h.id === itemId);
      if (!it) return;
      it.qualitiesLoading = false;
      it.qualities = M3U8Parser.singleQuality(m3u8Url, "Auto");
      it.selectedQualityIndex = 0;
      it.m3u8Url = m3u8Url;
      attachStreamInfo(it);
    });
  } finally {
    qualityResolvePending.delete(itemId);
    const history = await getHistory();
    const it = history.find((h) => h.id === itemId);
    if (it?.m3u8Url) {
      resolveDuration(itemId, it.m3u8Url, pageUrl, it.duration);
    }
  }
}

async function resolveDuration(itemId, m3u8Url, pageUrl, knownDuration) {
  if (durationResolvePending.has(itemId)) return;
  durationResolvePending.add(itemId);

  const history = await getHistory();
  const existing = history.find((h) => h.id === itemId);
  if (existing?.duration && !existing.durationLoading) {
    durationResolvePending.delete(itemId);
    return;
  }

  await updateHistory((hist) => {
    const item = hist.find((h) => h.id === itemId);
    if (item && !item.duration) item.durationLoading = true;
  });

  try {
    let duration = knownDuration > 0 ? knownDuration : null;
    const item = (await getHistory()).find((h) => h.id === itemId);
    const fetchUrl = item?.m3u8Url || m3u8Url;

    if (!duration && fetchUrl) {
      const text = await fetchPlaylistText(fetchUrl, pageUrl);
      if (M3U8Parser.isMasterPlaylist(text)) {
        const variants = M3U8Parser.parseMasterPlaylist(text, fetchUrl);
        const variant = variants[variants.length - 1] || variants[0];
        if (variant?.m3u8Url) {
          const mediaText = await fetchPlaylistText(variant.m3u8Url, pageUrl);
          duration = M3U8Parser.parseMediaPlaylistDuration(mediaText);
        }
      } else {
        duration = M3U8Parser.parseMediaPlaylistDuration(text);
      }
    }

    await updateHistory((hist) => {
      const it = hist.find((h) => h.id === itemId);
      if (!it) return;
      if (duration > 0) {
        applyDuration(it, duration);
        if (knownDuration > 0) it.durationSource = "player";
        else if (!it.durationSource) it.durationSource = "playlist";
      }
      it.durationLoading = false;
      attachStreamInfo(it);
    });
  } catch (_) {
    await updateHistory((hist) => {
      const it = hist.find((h) => h.id === itemId);
      if (it) it.durationLoading = false;
    });
  } finally {
    durationResolvePending.delete(itemId);
  }
}

async function upsertVideo({ pageUrl, title, m3u8Url, m3u8Candidates, tabId, duration }) {
  if (!m3u8Url) return null;
  if (!pageUrl || !isHttpPageUrl(pageUrl)) return null;
  pageUrl = normalizePageUrl(pageUrl);
  if (shouldSkipPage(pageUrl)) return null;
  if (tabId) tabIdsByPage.set(pageUrl, tabId);

  const now = Date.now();
  const videoId = videoIdFromM3u8(m3u8Url);
  let itemId = null;

  await updateHistory((history) => {
    let item = findHistoryItem(history, pageUrl, m3u8Url);

    if (item && m3u8Url && videoId && item.videoId && item.videoId !== videoId) {
      item = null;
    }

    if (item) {
      if (title) item.title = title;
      item.lastSeen = now;
      if (m3u8Url) {
        item.videoId = videoId;
        const changed = item.masterM3u8Url !== m3u8Url && item.m3u8Url !== m3u8Url;
        item.masterM3u8Url = m3u8Url;
        if (!item.qualities?.length || changed) {
          item.m3u8Url = m3u8Url;
        }
        if (item.status !== "done" && item.status !== "downloading") {
          item.status = item.qualities?.length ? "ready" : "waiting";
        }
        if (duration) applyDuration(item, duration);
      }
    } else {
      let displayTitle = title || pageUrl;
      if (m3u8Url && history.some((h) => normalizePageUrl(h.pageUrl) === pageUrl)) {
        const shortId = (videoId || "").split("/").filter(Boolean).pop() || "";
        if (shortId) displayTitle = `${displayTitle} (${shortId.slice(0, 8)}…)`;
      }
      item = {
        id: uuid(),
        pageUrl,
        videoId,
        title: displayTitle,
        m3u8Url: m3u8Url || null,
        masterM3u8Url: m3u8Url || null,
        qualities: [],
        selectedQualityIndex: 0,
        qualitiesLoading: false,
        status: m3u8Url ? "waiting" : "waiting",
        detectedAt: m3u8Url ? now : null,
        lastSeen: now,
        visitedAt: now,
        file: null,
        error: null,
      };
      history.unshift(item);
    }

    if (!item.visitedAt) item.visitedAt = item.detectedAt || now;
    if (m3u8Url && !item.detectedAt) item.detectedAt = now;
    if (m3u8Url) {
      item.m3u8Candidates = [
        ...new Set([...(item.m3u8Candidates || []), ...(m3u8Candidates || [])]),
      ];
      attachStreamInfo(item);
    }

    history.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    itemId = item.id;
  });

  if (m3u8Url && itemId) {
    const tid = tabId ?? tabIdsByPage.get(pageUrl);
    resolveAndAttachQualities(itemId, m3u8Url, pageUrl, tid, m3u8Candidates || []);
    if (duration) resolveDuration(itemId, m3u8Url, pageUrl, duration);
  }

  const history = await getHistory();
  return history.find((h) => h.id === itemId) || null;
}

async function updateVideo(id, patch) {
  await updateHistory((history) => {
    const item = history.find((h) => h.id === id);
    if (!item) return;
    Object.assign(item, patch);
  });
}

async function getCookieHeader(pageUrl) {
  let cookies = [];
  try {
    const u = new URL(pageUrl);
    cookies = await chrome.cookies.getAll({ url: pageUrl });
    if (!cookies.length) {
      cookies = await chrome.cookies.getAll({ domain: u.hostname });
    }
    if (!cookies.length && u.hostname.startsWith("www.")) {
      cookies = await chrome.cookies.getAll({ domain: u.hostname.slice(4) });
    }
  } catch (_) {
    /* ignore */
  }
  const map = new Map();
  for (const c of cookies) map.set(c.name, c.value);
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function nativeRequest(payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST);
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        try {
          port.disconnect();
        } catch (_) {}
        resolve(result);
      };
      port.onMessage.addListener((msg) => done({ ok: true, ...msg }));
      port.onDisconnect.addListener(() => {
        if (!settled) {
          done({
            ok: false,
            error: chrome.runtime.lastError?.message || "Native host disconnected",
          });
        }
      });
      port.postMessage(payload);
      setTimeout(() => done({ ok: false, error: "Request timeout" }), timeoutMs);
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

async function pingNativeHost() {
  return nativeRequest({ cmd: "ping" }, 5000);
}

function pathNormKey(p) {
  if (!p) return "";
  try {
    return p.replace(/\\/g, "/").toLowerCase();
  } catch {
    return "";
  }
}

function itemFileTag(item) {
  const id = (item.id || "").replace(/[^a-f0-9]/gi, "").toLowerCase();
  let tag = id.slice(0, 8);
  const vid = (item.videoId || "").replace(/[^a-f0-9]/gi, "").toLowerCase();
  const vpart = vid.length >= 8 ? vid.slice(-8) : vid;
  if (vpart && !tag.includes(vpart)) tag = (tag + vpart).slice(0, 16);
  return tag;
}

function historyItemByFileTag(hist, tag) {
  if (!tag) return null;
  const t = tag.toLowerCase();
  return (
    hist.find((h) => itemFileTag(h) === t) ||
    hist.find((h) => (h.id || "").replace(/-/g, "").toLowerCase().startsWith(t.slice(0, 8)))
  );
}

async function syncDownloadsWithDisk() {
  const settings = await getSettings();
  const outputDir = settings.outputDir?.trim();
  if (!outputDir) return { ok: false, error: "Set download folder first" };

  const listRes = await nativeRequest({ cmd: "listDir", outputDir });
  if (!listRes.ok) return listRes;

  const diskByPath = new Map();
  const diskByTag = new Map();
  for (const f of listRes.files || []) {
    diskByPath.set(pathNormKey(f.path), f);
    if (f.fileTag) diskByTag.set(f.fileTag.toLowerCase(), f);
  }

  let missing = 0;
  let restored = 0;
  let linked = 0;

  await updateHistory((hist) => {
    const claimed = new Set();

    for (const item of hist) {
      if (!item.downloadedAt && item.status === "done") item.downloadedAt = item.lastSeen || Date.now();
    }

    for (const item of hist) {
      if (item.status === "downloading") continue;
      const hadDownload = item.downloadedAt || item.file || item.status === "done";
      if (!hadDownload) continue;

      let disk = item.file ? diskByPath.get(pathNormKey(item.file)) : null;
      if (!disk) {
        const tag = itemFileTag(item);
        disk = diskByTag.get(tag);
        if (disk && item.file !== disk.path) {
          item.file = disk.path;
          linked++;
        }
      }

      if (disk) {
        claimed.add(pathNormKey(disk.path));
        item.file = disk.path;
        item.fileOnDisk = true;
        item.fileSize = disk.size;
        item.downloadedAt = item.downloadedAt || Date.now();
        if (item.status !== "downloading") {
          item.status = "done";
          item.error = null;
        }
        restored++;
      } else if (item.status === "done" || item.file) {
        item.fileOnDisk = false;
        item.file = null;
        item.fileSize = 0;
        item.status = "ready";
        item.error = null;
        item.progress = undefined;
        item.progressLabel = undefined;
        missing++;
      }
    }

    for (const [pathKey, disk] of diskByPath) {
      if (claimed.has(pathKey)) continue;
      const item = historyItemByFileTag(hist, disk.fileTag);
      if (item && !item.file) {
        item.file = disk.path;
        item.fileOnDisk = true;
        item.fileSize = disk.size;
        item.status = "done";
        item.downloadedAt = item.downloadedAt || disk.mtime || Date.now();
        claimed.add(pathKey);
        linked++;
      }
    }
  });

  return {
    ok: true,
    missing,
    restored,
    linked,
    fileCount: listRes.files?.length || 0,
    outputDir: listRes.outputDir,
  };
}

function clearDownloadBatchFields(item) {
  delete item.downloadBatchId;
  delete item.downloadBatchIndex;
  delete item.downloadBatchTotal;
}

async function resetStaleBatchItems(batchId, { includeDownloading = true } = {}) {
  await updateHistory((history) => {
    for (const item of history) {
      if (item.downloadBatchId !== batchId) continue;
      if (item.status === "queued" || (includeDownloading && item.status === "downloading")) {
        item.status = item.m3u8Url ? "ready" : item.status;
        item.progress = undefined;
        item.progressLabel = undefined;
        item.error = null;
        clearDownloadBatchFields(item);
      }
    }
  });
}

async function finishDownloadBatch(batchId) {
  await updateHistory((history) => {
    for (const item of history) {
      if (item.downloadBatchId !== batchId) continue;
      if (item.status === "queued") {
        item.status = item.m3u8Url ? "ready" : item.status;
        item.progress = undefined;
        item.progressLabel = undefined;
      }
      clearDownloadBatchFields(item);
    }
  });
}

async function downloadItems(itemIds, force = false) {
  const history = await getHistory();
  const settings = await getSettings();

  const items = history.filter((h) => {
    if (!itemIds.includes(h.id) || h.status === "downloading" || h.status === "queued") return false;
    if (!getSelectedM3u8(h)) return false;
    if (!force && h.status === "done" && h.fileOnDisk === true && h.file) return false;
    return true;
  });

  const cookieHeader = await getCookieHeader(items[0]?.pageUrl || "");

  if (!items.length) {
    return { ok: false, error: "No downloadable videos selected (need detected stream)" };
  }

  if (!settings.outputDir?.trim()) {
    return { ok: false, error: "Set a download folder first" };
  }

  const batchId = `batch-${Date.now()}`;
  const batchTotal = items.length;
  items.forEach((item, index) => {
    item.downloadBatchId = batchId;
    item.downloadBatchIndex = index;
    item.downloadBatchTotal = batchTotal;
    item.progress = undefined;
    item.progressLabel = undefined;
    item.error = null;
    item.status = index === 0 ? "downloading" : "queued";
    if (index === 0) {
      item.progress = 0;
      item.progressLabel = "Starting…";
    }
  });
  await setHistory(history);

  let batchFinished = false;

  const notifyBulkProgress = async () => {
    const hist = await getHistory();
    const batchItems = hist
      .filter((h) => h.downloadBatchId === batchId)
      .sort((a, b) => (a.downloadBatchIndex ?? 0) - (b.downloadBatchIndex ?? 0));
    if (!batchItems.length) return;
    const done = batchItems.filter((h) => h.status === "done").length;
    const current = batchItems.find((h) => h.status === "downloading");
    const total = batchItems[0]?.downloadBatchTotal || batchItems.length;
    const curPct = current?.progress ?? 0;
    const curProgress = curPct < 0 ? 0 : Math.min(100, curPct);
    const overallPercent = total ? Math.min(100, Math.round((done * 100 + curProgress) / total)) : 0;
    chrome.runtime
      .sendMessage({
        type: "bulkDownloadProgress",
        batchId,
        total,
        done,
        queued: batchItems.filter((h) => h.status === "queued").length,
        overallPercent,
        currentId: current?.id,
        currentTitle: current?.title,
        currentProgress: curPct,
        currentLabel: current?.progressLabel,
      })
      .catch(() => {});
  };

  return new Promise((resolve) => {
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST);

      port.onMessage.addListener((msg) => {
        if (msg.id) {
          const patch = {
            status: msg.status,
            file: msg.file,
            error: msg.message,
            fileOnDisk: msg.status === "done" ? true : msg.status === "error" ? false : undefined,
            fileSize: msg.fileSize,
            downloadedAt: msg.status === "done" ? Date.now() : undefined,
          };
          if (msg.progress !== undefined) {
            patch.progress = msg.progress;
            patch.progressLabel = msg.progressLabel;
          }
          updateVideo(msg.id, patch).then(async () => {
            if (msg.status === "downloading") {
              await updateHistory((hist) => {
                const active = hist.find((h) => h.id === msg.id);
                if (!active || active.downloadBatchId !== batchId) return;
                for (const item of hist) {
                  if (item.downloadBatchId !== batchId) continue;
                  if (item.id === msg.id) item.status = "downloading";
                  else if (item.status === "downloading" && item.id !== msg.id) item.status = "queued";
                }
              });
            }
            if (msg.status === "done" || msg.status === "error") {
              await updateHistory((hist) => {
                const item = hist.find((h) => h.id === msg.id);
                if (item?.status === "done") clearDownloadBatchFields(item);
              });
            }
            if (msg.status === "downloading" && msg.progress !== undefined) {
              chrome.runtime
                .sendMessage({
                  type: "downloadProgress",
                  id: msg.id,
                  progress: msg.progress,
                  progressLabel: msg.progressLabel,
                })
                .catch(() => {});
            }
            await notifyBulkProgress();
          });
        }
        if (msg.type === "complete") {
          batchFinished = true;
          finishDownloadBatch(batchId).catch(() => {});
          syncDownloadsWithDisk().catch(() => {});
          notifyBulkProgress().catch(() => {});
          port.disconnect();
          resolve({ ok: true, batchId, total: batchTotal });
        }
      });

      port.onDisconnect.addListener(() => {
        if (!batchFinished) resetStaleBatchItems(batchId).catch(() => {});
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        }
      });

      notifyBulkProgress().catch(() => {});

      port.postMessage({
        cmd: "download",
        outputDir: settings.outputDir,
        items: items.map((i) => {
          const q = i.qualities?.[i.selectedQualityIndex ?? 0];
          const qualitySuffix = q?.label ? ` [${q.label}]` : "";
          const forceNew = force || !i.file || i.fileOnDisk === false || i.status === "ready";
          return {
            id: i.id,
            videoId: i.videoId || videoIdFromM3u8(getSelectedM3u8(i)),
            m3u8Url: getSelectedM3u8(i),
            referer: i.pageUrl,
            title: i.title + qualitySuffix,
            cookieHeader,
            existingPath: i.file || "",
            forceNew,
          };
        }),
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url && isHttpPageUrl(changeInfo.url)) {
    await onTabPageChange(tabId, changeInfo.url, tab.title);
  }

  if (changeInfo.status !== "complete" || !tab.url || !isHttpPageUrl(tab.url)) return;
  const pageUrl = normalizePageUrl(tab.url);
  await onTabPageChange(tabId, pageUrl, tab.title);

  const stream = tabStreams.get(tabId);
  if (stream?.m3u8Url) {
    const streamPage = normalizePageUrl(stream.pageUrl || pageUrl);
    if (streamPage === pageUrl) {
      await upsertVideo({
        pageUrl: streamPage,
        title: stream.title || tab.title,
        m3u8Url: stream.m3u8Url,
        m3u8Candidates: stream.m3u8Urls || stream.m3u8Candidates || [],
        duration: stream.duration || null,
        tabId,
      });
    }
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0 || !isHttpPageUrl(details.url)) return;
  await onTabPageChange(details.tabId, details.url, "");
  try {
    const state = await chrome.tabs.sendMessage(details.tabId, { type: "getStreamState" });
    if (state?.pageUrl) {
      const streamPage = normalizePageUrl(state.pageUrl);
      if (streamPage !== normalizePageUrl(details.url)) {
        await onTabPageChange(details.tabId, streamPage, state.title);
      }
      if (state.m3u8Url) {
        await upsertVideo({
          pageUrl: streamPage,
          title: state.title,
          m3u8Url: state.m3u8Url,
          m3u8Candidates: state.m3u8Urls || [],
          duration: state.duration || null,
          tabId: details.tabId,
        });
      }
    }
  } catch (_) {
    /* content script not ready */
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const prev = tabLastUrl.get(tabId);
  if (prev) flushStreamForPage(prev, tabId);
  tabLastUrl.delete(tabId);
  tabStreams.delete(tabId);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url || !isHttpPageUrl(tab.url)) return;
    let pageUrl = normalizePageUrl(tab.url);
    let title = tab.title || "";
    try {
      const state = await chrome.tabs.sendMessage(activeInfo.tabId, { type: "getStreamState" });
      if (state?.pageUrl) pageUrl = normalizePageUrl(state.pageUrl);
      if (state?.title) title = state.title;
    } catch (_) {
      /* ignore */
    }
    await onTabPageChange(activeInfo.tabId, pageUrl, title);
    try {
      const state = await chrome.tabs.sendMessage(activeInfo.tabId, { type: "getStreamState" });
      if (state?.m3u8Url) {
        const streamPage = normalizePageUrl(state.pageUrl || pageUrl);
        await upsertVideo({
          pageUrl: streamPage,
          title: state.title || title,
          m3u8Url: state.m3u8Url,
          m3u8Candidates: state.m3u8Urls || [],
          duration: state.duration || null,
          tabId: activeInfo.tabId,
        });
      }
    } catch (_) {
      /* ignore */
    }
  } catch (_) {
    /* tab may be gone */
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "pageVisited":
      case "pageNavigated": {
        const tabId = sender.tab?.id;
        const payload = msg.payload;
        if (!payload?.pageUrl) {
          sendResponse({ ok: false });
          break;
        }
        await onTabPageChange(tabId, payload.pageUrl, payload.title);
        sendResponse({ ok: true });
        break;
      }
      case "streamDetected": {
        const tabId = sender.tab?.id;
        const payload = msg.payload;
        payload.pageUrl = normalizePageUrl(payload.pageUrl);
        if (tabId) {
          const prev = tabStreams.get(tabId);
          const prevVid = videoIdFromM3u8(prev?.m3u8Url);
          const newVid = videoIdFromM3u8(payload.m3u8Url);
          if (
            payload.isNewVideoOnPage ||
            (prev &&
              prev.pageUrl === payload.pageUrl &&
              newVid &&
              prevVid &&
              newVid !== prevVid)
          ) {
            tabStreams.delete(tabId);
          }
          tabStreams.set(tabId, payload);
          tabLastUrl.set(tabId, payload.pageUrl);
        }
        if (payload.m3u8Url) {
          chrome.action.setBadgeText({ text: "●", tabId });
          chrome.action.setBadgeBackgroundColor({ color: "#22c55e", tabId });
        }
        await upsertVideo({
          pageUrl: payload.pageUrl,
          title: payload.title,
          m3u8Url: payload.m3u8Url || null,
          m3u8Candidates: payload.m3u8Candidates || [],
          duration: payload.duration || null,
          tabId,
        });
        sendResponse({ ok: true });
        break;
      }
      case "setQuality": {
        const history = await getHistory();
        const item = history.find((h) => h.id === msg.id);
        if (!item || !item.qualities?.length) {
          sendResponse({ ok: false });
          break;
        }
        const index = Math.max(0, Math.min(msg.index, item.qualities.length - 1));
        item.selectedQualityIndex = index;
        item.m3u8Url = item.qualities[index].m3u8Url;
        await setHistory(history);
        sendResponse({ ok: true });
        break;
      }
      case "getHistory":
        sendResponse({ history: await getHistory() });
        break;
      case "getActiveTab": {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) {
          sendResponse({ url: "", title: "" });
          break;
        }
        let url = tab.url ? normalizePageUrl(tab.url) : "";
        let title = tab.title || "";
        const tracked = tabLastUrl.get(tab.id);

        try {
          const state = await chrome.tabs.sendMessage(tab.id, { type: "getStreamState" });
          if (state?.pageUrl) url = normalizePageUrl(state.pageUrl);
          if (state?.title) title = state.title;
        } catch (_) {
          if (tracked) url = tracked;
        }

        if (tracked && tracked.includes("#/") && url && !url.includes("#/")) {
          url = tracked;
        }

        sendResponse({ url, title, tabId: tab.id });
        break;
      }
      case "refreshCurrentTab": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          sendResponse({ ok: false });
          break;
        }
        let stream = tabStreams.get(tab.id);
        if (!stream) {
          try {
            stream = await chrome.tabs.sendMessage(tab.id, { type: "getStreamState" });
          } catch (_) {
            stream = null;
          }
        }
        if (tab.url) {
          const pageUrl = normalizePageUrl(stream?.pageUrl || tab.url);
          await onTabPageChange(tab.id, pageUrl, stream?.title || tab.title);
          if (stream?.m3u8Url) {
            await upsertVideo({
              pageUrl,
              title: stream?.title || tab.title,
              m3u8Url: stream.m3u8Url,
              m3u8Candidates: stream.m3u8Urls || stream.m3u8Candidates || [],
              duration: stream?.duration || null,
              tabId: tab.id,
            });
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case "getSettings":
        sendResponse({ settings: await getSettings() });
        break;
      case "setSettings":
        await setSettings(msg.settings);
        sendResponse({ ok: true });
        break;
      case "applyQualityPreference":
        sendResponse(await applyQualityPreferenceToHistory());
        break;
      case "removeItems": {
        const ids = new Set(msg.ids || []);
        const history = (await getHistory()).filter((h) => !ids.has(h.id));
        await setHistory(history);
        sendResponse({ ok: true });
        break;
      }
      case "clearHistory":
        await setHistory([]);
        sendResponse({ ok: true });
        break;
      case "pingHost":
        sendResponse(await pingNativeHost());
        break;
      case "downloadItems":
        sendResponse(await downloadItems(msg.ids || [], Boolean(msg.force)));
        break;
      case "openPage": {
        const item = (await getHistory()).find((h) => h.id === msg.id);
        if (item?.pageUrl) {
          await chrome.tabs.create({ url: item.pageUrl, active: true });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
        break;
      }
      case "saveSelection":
        await chrome.storage.local.set({
          selectedVideoIdsByTab: {
            visited: msg.visitedIds || [],
            current: msg.currentIds || [],
          },
        });
        sendResponse({ ok: true });
        break;
      case "loadSelection": {
        const data = await chrome.storage.local.get(["selectedVideoIdsByTab", "selectedVideoIds"]);
        const byTab = data.selectedVideoIdsByTab || {};

        // Back-compat: older versions stored a single flat list.
        const legacy = data.selectedVideoIds || [];
        const visited = Array.isArray(byTab.visited) ? byTab.visited : legacy;
        const current = Array.isArray(byTab.current) ? byTab.current : [];

        sendResponse({ visitedIds: visited || [], currentIds: current || [] });
        break;
      }
      case "listDownloadDir": {
        const settings = await getSettings();
        const outputDir = msg.outputDir || settings.outputDir;
        if (!outputDir?.trim()) {
          sendResponse({ ok: false, error: "Set download folder first" });
          break;
        }
        sendResponse(await nativeRequest({ cmd: "listDir", outputDir }));
        break;
      }
      case "openFile":
        sendResponse(await nativeRequest({ cmd: "openPath", path: msg.path }));
        break;
      case "openFolder": {
        const settings = await getSettings();
        sendResponse(
          await nativeRequest({
            cmd: "openFolder",
            path: msg.path,
            outputDir: msg.outputDir || settings.outputDir,
          })
        );
        break;
      }
      case "verifyDownloads":
      case "syncDownloads":
        sendResponse(await syncDownloadsWithDisk());
        break;
      case "resetForDownload": {
        await updateVideo(msg.id, {
          status: "ready",
          error: null,
          file: null,
          fileOnDisk: false,
          fileSize: 0,
          progress: undefined,
          progressLabel: undefined,
        });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message" });
    }
  })();
  return true;
});

getHistory().then(async (history) => {
  const withStreams = history.filter((h) => h.m3u8Url || h.masterM3u8Url);
  const trimmed = dedupeHistory(withStreams);
  if (trimmed.length !== history.length) await setHistory(trimmed);
  getSettings().then((s) => {
    if (s.outputDir?.trim()) syncDownloadsWithDisk().catch(() => {});
  });
});

// Migrate old queue storage
chrome.storage.local.get("queue").then((data) => {
  if (!data.queue?.length) return;
  getHistory().then(async (history) => {
    if (history.length) return;
    for (const q of data.queue) {
      await upsertVideo({
        pageUrl: q.pageUrl,
        title: q.title,
        m3u8Url: q.m3u8Url,
      });
    }
    chrome.storage.local.remove("queue");
  });
});
