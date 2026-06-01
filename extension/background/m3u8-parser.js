/* global self */
"use strict";

function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF:/i.test(text);
}

function parseAttrs(line) {
  const attrs = {};
  const body = line.includes(":") ? line.split(":").slice(1).join(":") : line;
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/gi;
  let m;
  while ((m = re.exec(body))) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function resolveUrl(baseUrl, ref) {
  try {
    return new URL(ref, baseUrl).href;
  } catch {
    return ref;
  }
}

function formatQualityLabel(variant) {
  if (variant.name) return variant.name;
  if (variant.resolution) {
    const h = parseInt(variant.resolution.split("x")[1], 10);
    if (h >= 2160) return "2160p";
    if (h >= 1440) return "1440p";
    if (h >= 1080) return "1080p";
    if (h >= 720) return "720p";
    if (h >= 480) return "480p";
    if (h >= 360) return "360p";
    return variant.resolution;
  }
  if (variant.bandwidth) return `${Math.round(variant.bandwidth / 1000)} kbps`;
  return "Stream";
}

function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const attrs = parseAttrs(lines[i]);
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith("#"))) j++;
    if (j >= lines.length || !lines[j]) continue;

    const bandwidth = parseInt(attrs.BANDWIDTH || "0", 10) || 0;
    const resolution = attrs.RESOLUTION || "";
    const name = attrs.NAME || "";
    variants.push({
      label: "",
      m3u8Url: resolveUrl(baseUrl, lines[j]),
      bandwidth,
      resolution,
      name,
    });
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  const seen = new Set();
  return variants
    .filter((v) => {
      if (seen.has(v.m3u8Url)) return false;
      seen.add(v.m3u8Url);
      v.label = formatQualityLabel(v);
      return true;
    })
    .map((v, i, arr) => {
      const dup = arr.filter((x) => x.label === v.label);
      if (dup.length > 1) {
        v.label = `${v.label} (${Math.round(v.bandwidth / 1000)}k)`;
      }
      return v;
    });
}

function singleQuality(m3u8Url, label) {
  return [
    {
      label: label || "Auto",
      m3u8Url,
      bandwidth: 0,
      resolution: "",
      name: "",
    },
  ];
}

function mergeQualityLists(lists) {
  const all = lists.flat();
  all.sort((a, b) => b.bandwidth - a.bandwidth);
  const seen = new Set();
  return all.filter((q) => {
    if (seen.has(q.m3u8Url)) return false;
    seen.add(q.m3u8Url);
    return true;
  });
}

const RES_BANDWIDTH = {
  "2160p": 16000000,
  "1440p": 8000000,
  "1080p": 5000000,
  "720p": 2800000,
  "480p": 1400000,
  "360p": 800000,
  "240p": 400000,
};

function pickBestQualityIndex(qualities) {
  if (!qualities?.length) return 0;
  let best = 0;
  for (let i = 1; i < qualities.length; i++) {
    if ((qualities[i].bandwidth || 0) > (qualities[best].bandwidth || 0)) best = i;
  }
  return best;
}

function pickWorstQualityIndex(qualities) {
  if (!qualities?.length) return 0;
  let worst = 0;
  for (let i = 1; i < qualities.length; i++) {
    if ((qualities[i].bandwidth || 0) < (qualities[worst].bandwidth || 0)) worst = i;
  }
  return worst;
}

function qualityHeight(q) {
  const label = (q.label || "").toLowerCase();
  const m = label.match(/(\d{3,4})p/);
  if (m) return parseInt(m[1], 10);
  if (q.resolution) {
    const parts = q.resolution.split("x");
    if (parts.length === 2) return parseInt(parts[1], 10) || 0;
  }
  if (q.bandwidth) return q.bandwidth;
  return 0;
}

/**
 * @param {Array} qualities
 * @param {string} preference best | worst | 1080p | 720p | 480p | 360p | 240p
 */
function pickQualityIndex(qualities, preference = "best") {
  if (!qualities?.length) return 0;
  const pref = String(preference || "best").toLowerCase();

  if (pref === "best" || pref === "highest") return pickBestQualityIndex(qualities);
  if (pref === "worst" || pref === "lowest") return pickWorstQualityIndex(qualities);

  const targetMatch = pref.match(/^(\d{3,4})p$/);
  if (!targetMatch) return pickBestQualityIndex(qualities);

  const targetH = parseInt(targetMatch[1], 10);
  let closestIdx = 0;
  let closestDiff = Infinity;
  let bestAtOrBelow = -1;
  let bestAtOrBelowH = -1;

  for (let i = 0; i < qualities.length; i++) {
    const h = qualityHeight(qualities[i]);
    const diff = Math.abs(h - targetH);
    if (h > 0 && h <= targetH && h >= bestAtOrBelowH) {
      bestAtOrBelow = i;
      bestAtOrBelowH = h;
    }
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIdx = i;
    }
  }

  return bestAtOrBelow >= 0 ? bestAtOrBelow : closestIdx;
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** Sum #EXTINF durations from a media (segment) playlist. */
function parseMediaPlaylistDuration(text) {
  if (!text) return null;
  const re = /#EXTINF:([\d.]+)/gi;
  let total = 0;
  let m;
  let count = 0;
  while ((m = re.exec(text))) {
    total += parseFloat(m[1]) || 0;
    count++;
    if (count > 50000) break;
  }
  return total > 0 ? total : null;
}

function shortStreamId(m3u8Url) {
  const prefix = videoFolderPrefix(m3u8Url);
  if (!prefix) return "";
  const parts = prefix.split("/").filter(Boolean);
  const uuid = parts.find((p) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p)
  );
  return uuid ? `${uuid.slice(0, 8)}…` : "";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function videoFolderPrefix(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const uuidIdx = parts.findIndex((p) => UUID_RE.test(p));
    if (uuidIdx >= 0) return "/" + parts.slice(0, uuidIdx + 1).join("/") + "/";
  } catch (_) {
    /* ignore */
  }
  return "";
}

/** HLS/DASH manifests and fMP4 playlist URLs (not plain progressive MP4 files). */
function isStreamManifestUrl(url) {
  if (!url || typeof url !== "string") return false;
  const path = url.split("?")[0];
  if (/\.m3u8(\?|$)/i.test(url) || url.includes(".m3u8?")) return true;
  if (/\.mpd(\?|$)/i.test(url)) return true;
  if (/-fragmented\.mp4(\?|$)/i.test(url)) return true;
  if (/-fmp4\.mp4(\?|$)/i.test(url)) return true;
  if (/\/hls\/[^/]+\/[^/]+\.mp4(\?|$)/i.test(path)) return true;
  if (/\/[^/]*(manifest|playlist)[^/]*\.mp4(\?|$)/i.test(path)) return true;
  return false;
}

function isMediaSegmentUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /\.ts(\?|$)/i.test(url) || /\.m4s(\?|$)/i.test(url) || /\.cmfv(\?|$)/i.test(url);
}

function qualityHeightFromStreamUrl(url) {
  if (!url) return 0;
  const frag = url.match(/-(\d{3,4})-fragmented\.mp4/i);
  if (frag) return parseInt(frag[1], 10);
  const res = url.match(/\/(\d{3,4}p)\/video\.m3u8/i);
  if (res) return parseInt(res[1], 10);
  const h = url.match(/-(\d{3,4})p(?:-fragmented)?\.mp4/i);
  if (h) return parseInt(h[1], 10);
  return 0;
}

function qualityLabelFromStreamUrl(url) {
  const h = qualityHeightFromStreamUrl(url);
  if (h >= 2160) return "2160p";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  if (h >= 360) return "360p";
  if (h >= 240) return "240p";
  if (h > 0) return `${h}p`;
  if (/\.mpd/i.test(url)) return "DASH";
  if (/-fragmented\.mp4/i.test(url)) return "fMP4";
  return "Auto";
}

/**
 * Stable id for one logical video — merges master + variant m3u8 URLs (same CDN folder).
 */
function canonicalStreamKey(m3u8Url) {
  if (!m3u8Url || typeof m3u8Url !== "string") return "";
  const stripped = m3u8Url.split("?")[0];
  const prefix = videoFolderPrefix(stripped);
  if (prefix) return prefix;

  try {
    const u = new URL(stripped);
    let path = u.pathname.replace(/\/+$/, "") || "/";
    path = path.replace(/\/\d{3,4}p\/[^/]+\.m3u8$/i, "");
    path = path.replace(/\/(?:playlist|master|index|stream|video)\.m3u8$/i, "");
    path = path.replace(/\/[^/]+-\d{3,4}-fragmented\.mp4$/i, "/");
    path = path.replace(/\/[^/]+-fmp4\.mp4$/i, "/");
    if (path && path !== "/") return `${u.origin}${path.endsWith("/") ? path : path + "/"}`;
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return stripped;
  }
}

/** Common CDN poster paths (Bunny, etc.) — probed in order by the service worker. */
function thumbnailGuessCandidates(m3u8Url) {
  if (!m3u8Url) return [];
  try {
    const u = new URL(m3u8Url);
    const prefix = videoFolderPrefix(m3u8Url);
    const path = u.pathname.replace(/\/[^/]+$/, "/");
    const bases = new Set();
    if (prefix) bases.add(`${u.origin}${prefix}`);
    if (path && path !== "/") bases.add(`${u.origin}${path.endsWith("/") ? path : path + "/"}`);
    const names = [
      "thumbnail.jpg",
      "thumbnail.webp",
      "preview.jpg",
      "preview.webp",
      "poster.jpg",
      "cover.jpg",
      "play_720p.jpg",
    ];
    const out = [];
    for (const base of bases) {
      for (const name of names) out.push(`${base}${name}`);
    }
    return out;
  } catch (_) {
    return [];
  }
}

function thumbnailGuessFromStreamUrl(m3u8Url) {
  return thumbnailGuessCandidates(m3u8Url)[0] || "";
}

function sameStreamFolder(prefix, url) {
  if (!prefix) return true;
  try {
    return new URL(url).pathname.startsWith(prefix);
  } catch (_) {
    return false;
  }
}

/** Build quality list from network-detected manifest URLs (m3u8, fMP4, DASH). */
function qualitiesFromDetectedUrls(urls, primaryUrl) {
  const prefix = videoFolderPrefix(primaryUrl || urls[0] || "");
  const qualities = [];

  for (const url of urls) {
    if (!url || !isStreamManifestUrl(url)) continue;
    if (!sameStreamFolder(prefix, url)) continue;
    if (/\/playlist\.m3u8/i.test(url)) continue;

    const resMatch = url.match(/\/(\d{3,4}p)\/video\.m3u8/i);
    if (resMatch) {
      const label = resMatch[1].toLowerCase();
      qualities.push({
        label,
        m3u8Url: url,
        bandwidth: RES_BANDWIDTH[label] || 0,
        resolution: "",
        name: "",
      });
      continue;
    }

    const fragMatch = url.match(/-(\d{3,4})-fragmented\.mp4/i);
    if (fragMatch) {
      const label = `${fragMatch[1]}p`;
      qualities.push({
        label,
        m3u8Url: url,
        bandwidth: RES_BANDWIDTH[label] || qualityHeightFromStreamUrl(url) * 10000,
        resolution: "",
        name: "",
      });
      continue;
    }

    if (/-fragmented\.mp4|\.mpd|\/hls\/[^/]+\/[^/]+\.mp4/i.test(url)) {
      const label = qualityLabelFromStreamUrl(url);
      qualities.push({
        label,
        m3u8Url: url,
        bandwidth: qualityHeightFromStreamUrl(url) * 10000,
        resolution: "",
        name: "",
      });
    }
  }

  qualities.sort((a, b) => b.bandwidth - a.bandwidth);
  const seen = new Set();
  return qualities.filter((q) => {
    if (seen.has(q.m3u8Url)) return false;
    seen.add(q.m3u8Url);
    return true;
  });
}

self.M3U8Parser = {
  isMasterPlaylist,
  parseMasterPlaylist,
  parseMediaPlaylistDuration,
  formatDuration,
  singleQuality,
  mergeQualityLists,
  formatQualityLabel,
  qualitiesFromDetectedUrls,
  videoFolderPrefix,
  isStreamManifestUrl,
  isMediaSegmentUrl,
  qualityLabelFromStreamUrl,
  qualityHeightFromStreamUrl,
  canonicalStreamKey,
  pickBestQualityIndex,
  pickWorstQualityIndex,
  pickQualityIndex,
  qualityHeight,
  shortStreamId,
  thumbnailGuessFromStreamUrl,
  thumbnailGuessCandidates,
};
