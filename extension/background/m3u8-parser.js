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

function videoFolderPrefix(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const uuidIdx = parts.findIndex((p) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p)
    );
    if (uuidIdx >= 0) return "/" + parts.slice(0, uuidIdx + 1).join("/") + "/";
  } catch (_) {
    /* ignore */
  }
  return "";
}

/** Build quality list from network-detected m3u8 URLs (Bunny CDN: /720p/video.m3u8). */
function qualitiesFromDetectedUrls(urls, primaryUrl) {
  const prefix = videoFolderPrefix(primaryUrl || urls[0] || "");
  const qualities = [];

  for (const url of urls) {
    if (!url || !/\.m3u8/i.test(url)) continue;
    if (prefix) {
      try {
        if (!new URL(url).pathname.startsWith(prefix)) continue;
      } catch (_) {
        continue;
      }
    }

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

    if (/\/playlist\.m3u8/i.test(url)) continue;
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
  pickBestQualityIndex,
  shortStreamId,
};
