(function () {
  "use strict";

  if (window !== window.top) return;
  if (window.__videoDownloaderInjected) return;
  window.__videoDownloaderInjected = true;

  const m3u8Urls = new Set();
  let sampleTsUrl = null;
  let activeVideoFolder = null;
  let lastNotifiedFolder = null;
  let extensionAlive = true;
  let notifyTimer = null;

  function markDead() {
    extensionAlive = false;
    clearTimeout(notifyTimer);
  }

  function isExtensionAlive() {
    if (!extensionAlive) return false;
    try {
      if (typeof chrome === "undefined" || !chrome.runtime) return false;
      void chrome.runtime.id;
      return true;
    } catch {
      markDead();
      return false;
    }
  }

  function safeSendMessage(message) {
    if (!isExtensionAlive()) return;
    try {
      chrome.runtime.sendMessage(message, () => {
        try {
          const err = chrome.runtime.lastError;
          if (err) markDead();
        } catch {
          markDead();
        }
      });
    } catch {
      markDead();
    }
  }

  function isM3u8(url) {
    return /\.m3u8(\?|$)/i.test(url) || url.includes(".m3u8?");
  }

  function isTs(url) {
    return /\.ts(\?|$)/i.test(url);
  }

  /** HLS m3u8, DASH mpd, and fMP4 manifests (e.g. …/hls/…/…-240-fragmented.mp4). */
  function isStreamManifest(url) {
    if (!url || typeof url !== "string") return false;
    const path = url.split("?")[0];
    if (isM3u8(url)) return true;
    if (/\.mpd(\?|$)/i.test(url)) return true;
    if (/-fragmented\.mp4(\?|$)/i.test(url)) return true;
    if (/-fmp4\.mp4(\?|$)/i.test(url)) return true;
    if (/\/hls\/[^/]+\/[^/]+\.mp4(\?|$)/i.test(path)) return true;
    if (/\/[^/]*(manifest|playlist)[^/]*\.mp4(\?|$)/i.test(path)) return true;
    return false;
  }

  function streamQualityRank(url) {
    const frag = url.match(/-(\d{3,4})-fragmented\.mp4/i);
    if (frag) return parseInt(frag[1], 10);
    const named = url.match(/\/(\d{3,4})p\/video\.m3u8/i);
    if (named) return parseInt(named[1], 10);
    return 0;
  }

  function playlistCandidatesFromTs(tsUrl) {
    const candidates = [];
    try {
      const u = new URL(tsUrl);
      const path = u.pathname;
      const dir = path.substring(0, path.lastIndexOf("/") + 1);
      const names = ["index.m3u8", "playlist.m3u8", "master.m3u8", "stream.m3u8"];
      for (const name of names) {
        candidates.push(u.origin + dir + name + u.search);
      }
    } catch (_) {
      /* ignore */
    }
    return candidates;
  }

  function playlistCandidatesNearStream(streamUrl) {
    const candidates = [];
    try {
      const u = new URL(streamUrl);
      const dir = u.pathname.substring(0, u.pathname.lastIndexOf("/") + 1);
      const names = [
        "index.m3u8",
        "playlist.m3u8",
        "master.m3u8",
        "stream.m3u8",
        "manifest.m3u8",
        "manifest.mpd",
      ];
      for (const name of names) {
        candidates.push(u.origin + dir + name + u.search);
      }
    } catch (_) {
      /* ignore */
    }
    return candidates;
  }

  function pickBestM3u8(urls) {
    const list = [...urls];
    const master = list.find((u) => /\/playlist\.m3u8/i.test(u));
    if (master) return master;

    const fragmented = list.filter(
      (u) => /-fragmented\.mp4/i.test(u) || /\/hls\/[^/]+\/[^/]+\.mp4/i.test(u.split("?")[0])
    );
    if (fragmented.length) {
      fragmented.sort((a, b) => streamQualityRank(b) - streamQualityRank(a));
      return fragmented[0];
    }

    const dash = list.find((u) => /\.mpd(\?|$)/i.test(u));
    if (dash) return dash;

    const named = list.filter((u) => /\/\d{3,4}p\/video\.m3u8/i.test(u));
    if (named.length) {
      const order = ["1080p", "720p", "480p", "360p", "240p"];
      for (const q of order) {
        const hit = named.find((u) => u.includes(`/${q}/`));
        if (hit) return hit;
      }
      return named[0];
    }
    return list.sort((a, b) => b.length - a.length)[0] || null;
  }

  function metaContent(selector) {
    const el = document.querySelector(selector);
    return el?.getAttribute("content")?.trim() || "";
  }

  function readPageMeta() {
    return {
      ogTitle:
        metaContent('meta[property="og:title"]') || metaContent('meta[name="og:title"]'),
      ogImage:
        metaContent('meta[property="og:image"]') ||
        metaContent('meta[name="og:image"]') ||
        metaContent('meta[property="og:image:url"]'),
      twitterImage: metaContent('meta[name="twitter:image"]'),
      documentTitle: document.title?.trim() || "",
    };
  }

  function isGenericTitle(text) {
    if (!text || text.length < 3) return true;
    const s = text.trim().toLowerCase();
    if (s === "video" || s === "untitled" || s === "loading" || s === "loading...") return true;
    if (/^(home|dashboard|courses?|login|sign in|sign up)$/.test(s)) return true;
    return false;
  }

  function cleanDocumentTitle(title) {
    if (!title) return "";
    const parts = title.split(/\s*[|\-–—]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const left = parts[0];
      const right = parts[parts.length - 1];
      if (left.length >= right.length && left.length >= 8) return left;
      if (right.length >= 8) return right;
    }
    return title.trim();
  }

  function visibleArea(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 45) return 0;
    const x0 = Math.max(0, r.left);
    const y0 = Math.max(0, r.top);
    const x1 = Math.min(window.innerWidth, r.right);
    const y1 = Math.min(window.innerHeight, r.bottom);
    if (x1 <= x0 || y1 <= y0) return 0;
    return (x1 - x0) * (y1 - y0);
  }

  function getActiveVideo() {
    const videos = [...document.querySelectorAll("video")];
    let best = null;
    let bestArea = 0;
    for (const v of videos) {
      const area = visibleArea(v);
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best || videos[0] || null;
  }

  function titleFromVideoElement(video) {
    if (!video) return "";
    const aria = video.getAttribute("aria-label")?.trim();
    if (aria && !isGenericTitle(aria)) return aria;
    const titleAttr = video.getAttribute("title")?.trim();
    if (titleAttr && !isGenericTitle(titleAttr)) return titleAttr;
    const track = video.querySelector('track[kind="captions"], track[kind="subtitles"]');
    if (track?.label && !isGenericTitle(track.label)) return track.label.trim();
    return "";
  }

  function resolveVideoTitle(video) {
    const fromVideo = titleFromVideoElement(video);
    if (fromVideo) return fromVideo;
    const meta = readPageMeta();
    if (meta.ogTitle && !isGenericTitle(meta.ogTitle)) return meta.ogTitle;
    const cleaned = cleanDocumentTitle(meta.documentTitle);
    if (cleaned && !isGenericTitle(cleaned)) return cleaned;
    const h1 = document.querySelector("h1");
    const h1Text = h1?.textContent?.trim();
    if (h1Text && h1Text.length >= 4 && h1Text.length < 140 && !isGenericTitle(h1Text)) return h1Text;
    return cleaned || meta.documentTitle || "Video";
  }

  function resolvePageTitle() {
    const meta = readPageMeta();
    return cleanDocumentTitle(meta.documentTitle) || meta.ogTitle || "";
  }

  function resolveAbsoluteUrl(url) {
    if (!url || typeof url !== "string") return "";
    try {
      return new URL(url, location.href).href;
    } catch (_) {
      return url;
    }
  }

  function captureVideoFrameDataUrl(video) {
    if (!video || video.readyState < 2) return "";
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return "";
    try {
      const maxW = 320;
      const tw = Math.min(w, maxW);
      const th = Math.round((tw / w) * h);
      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, tw, th);
      const data = canvas.toDataURL("image/jpeg", 0.85);
      return data.length > 5000 ? data : "";
    } catch (_) {
      return "";
    }
  }

  function findThumbnailNearPlayer() {
    const video = getActiveVideo();
    if (!video) return "";
    let el = video.parentElement;
    for (let depth = 0; depth < 10 && el; depth++) {
      const imgs = el.querySelectorAll("img[src], img[data-src], img[data-lazy-src]");
      for (const img of imgs) {
        const raw =
          img.getAttribute("data-src") ||
          img.getAttribute("data-lazy-src") ||
          img.currentSrc ||
          img.src ||
          "";
        const u = resolveAbsoluteUrl(raw);
        if (!u || u.startsWith("data:") || /sprite|icon|logo|avatar|1x1|pixel/i.test(u)) continue;
        const r = img.getBoundingClientRect();
        if (r.width >= 80 && r.height >= 45) return u;
      }
      el = el.parentElement;
    }
    return "";
  }

  function resolveThumbnailUrl(video, _m3u8Url) {
    const poster = resolveAbsoluteUrl(video?.poster || video?.getAttribute("poster") || "");
    if (poster && /^https?:/i.test(poster)) return poster;
    const meta = readPageMeta();
    const og = resolveAbsoluteUrl(meta.ogImage);
    if (og && /^https?:/i.test(og)) return og;
    const tw = resolveAbsoluteUrl(meta.twitterImage);
    if (tw && /^https?:/i.test(tw)) return tw;
    const near = findThumbnailNearPlayer();
    if (near) return near;
    return "";
  }

  function collectStreamMetadata(m3u8Url) {
    const video = getActiveVideo();
    const meta = readPageMeta();
    const thumbnailDataUrl = captureVideoFrameDataUrl(video);
    return {
      title: resolveVideoTitle(video),
      pageTitle: resolvePageTitle(),
      thumbnailUrl: resolveThumbnailUrl(video, m3u8Url),
      thumbnailDataUrl: thumbnailDataUrl || "",
      duration: getPlayerDuration(),
      videoWidth: video?.videoWidth > 0 ? video.videoWidth : null,
      videoHeight: video?.videoHeight > 0 ? video.videoHeight : null,
      ogTitle: meta.ogTitle || null,
    };
  }

  function pageTitle() {
    return resolveVideoTitle(getActiveVideo());
  }

  function getPlayerDuration() {
    const video = getActiveVideo();
    if (!video) return null;
    const d = video.duration;
    if (d && Number.isFinite(d) && d > 0) return Math.round(d);
    return null;
  }

  /** Bunny CDN folder = unique video asset (UUID in path). */
  function videoFolderFromUrl(url) {
    if (!url) return "";
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      const uuidIdx = parts.findIndex((p) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p)
      );
      if (uuidIdx >= 0) return parts.slice(0, uuidIdx + 1).join("/");
    } catch (_) {
      /* ignore */
    }
    return url.split("?")[0];
  }

  function purgeFolder(folder) {
    if (!folder) return;
    for (const u of [...m3u8Urls]) {
      if (videoFolderFromUrl(u) === folder) m3u8Urls.delete(u);
    }
    if (sampleTsUrl && videoFolderFromUrl(sampleTsUrl) === folder) {
      sampleTsUrl = null;
    }
  }

  function resetStreamState() {
    m3u8Urls.clear();
    sampleTsUrl = null;
    activeVideoFolder = null;
    lastNotifiedFolder = null;
  }

  function onVideoSourceChange() {
    resetStreamState();
    setTimeout(notifyNow, 600);
    setTimeout(notifyNow, 1800);
    setTimeout(notifyNow, 4000);
  }

  function resetForNavigation() {
    resetStreamState();
  }

  function watchVideoElements() {
    const attach = (video) => {
      if (!video || video.__vdBound) return;
      video.__vdBound = true;
      video.addEventListener("loadstart", onVideoSourceChange);
      video.addEventListener("emptied", onVideoSourceChange);
      video.addEventListener("loadeddata", () => {
        trackVideoElementSrc();
        notify();
      });
      video.addEventListener("loadedmetadata", () => {
        trackVideoElementSrc();
        notify();
      });
    };

    const scan = () => document.querySelectorAll("video").forEach(attach);

    scan();
    try {
      new MutationObserver(scan).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (_) {
      /* ignore */
    }
  }

  function notifyNow() {
    if (!isExtensionAlive()) return;

    trackVideoElementSrc();

    let m3u8Url = pickBestM3u8(m3u8Urls);
    if (!m3u8Url && sampleTsUrl) {
      m3u8Url = playlistCandidatesFromTs(sampleTsUrl)[0] || null;
    }
    if (!m3u8Url) {
      for (const u of m3u8Urls) {
        for (const candidate of playlistCandidatesNearStream(u)) {
          if (!m3u8Urls.has(candidate)) m3u8Urls.add(candidate);
        }
      }
      m3u8Url = pickBestM3u8(m3u8Urls);
    }

    const folder = m3u8Url ? videoFolderFromUrl(m3u8Url) : null;
    const folderChanged =
      folder && lastNotifiedFolder && folder !== lastNotifiedFolder;
    if (folder) lastNotifiedFolder = folder;

    const streamMeta = collectStreamMetadata(m3u8Url);
    safeSendMessage({
      type: "streamDetected",
      payload: {
        m3u8Url,
        m3u8Candidates: [...m3u8Urls],
        sampleTsUrl,
        pageUrl: location.href,
        title: streamMeta.title,
        pageTitle: streamMeta.pageTitle,
        thumbnailUrl: streamMeta.thumbnailUrl,
        thumbnailDataUrl: streamMeta.thumbnailDataUrl,
        duration: streamMeta.duration,
        videoWidth: streamMeta.videoWidth,
        videoHeight: streamMeta.videoHeight,
        videoFolder: folder,
        isNewVideoOnPage: !!folderChanged,
      },
    });
  }

  function notify() {
    if (!isExtensionAlive()) return;
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(notifyNow, 500);
  }

  function resolvePageUrl(url) {
    if (!url || typeof url !== "string") return "";
    try {
      return new URL(url, location.href).href;
    } catch (_) {
      return url;
    }
  }

  function trackVideoElementSrc() {
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      const src = resolvePageUrl(video.currentSrc || video.src || "");
      if (src && !src.startsWith("blob:") && !src.startsWith("data:")) trackUrl(src);
      video.querySelectorAll("source[src]").forEach((s) => {
        const u = resolvePageUrl(s.getAttribute("src"));
        if (u && !u.startsWith("blob:")) trackUrl(u);
      });
    }
  }

  function trackUrl(url) {
    if (!isExtensionAlive() || !url || typeof url !== "string") return;
    url = resolvePageUrl(url);
    if (url.startsWith("blob:") || url.startsWith("data:")) return;

    if (isM3u8(url) || isStreamManifest(url)) {
      const folder = videoFolderFromUrl(url);
      if (activeVideoFolder && folder && folder !== activeVideoFolder) {
        purgeFolder(activeVideoFolder);
        activeVideoFolder = folder;
        notifyNow();
      }
      if (!activeVideoFolder && folder) activeVideoFolder = folder;

      if (!m3u8Urls.has(url)) {
        m3u8Urls.add(url);
        notify();
      }
      return;
    }

    if (isTs(url)) {
      const folder = videoFolderFromUrl(url);
      if (activeVideoFolder && folder && folder !== activeVideoFolder) {
        purgeFolder(activeVideoFolder);
        activeVideoFolder = folder;
        sampleTsUrl = url;
        notifyNow();
        return;
      }
      if (!sampleTsUrl || videoFolderFromUrl(sampleTsUrl) !== folder) {
        sampleTsUrl = url;
        if (folder) activeVideoFolder = folder;
        notify();
      }
    }
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    trackUrl(url);
    return origOpen.call(this, method, url, ...rest);
  };

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : "";
      trackUrl(url);
      return origFetch.apply(this, arguments);
    };
  }

  let lastReportedHref = "";

  function reportPageVisit() {
    const href = location.href;
    if (!href || href === lastReportedHref) return;
    lastReportedHref = href;
    safeSendMessage({
      type: "pageNavigated",
      payload: { pageUrl: href, title: resolvePageTitle() || pageTitle() },
    });
  }

  function onRouteChange() {
    resetForNavigation();
    reportPageVisit();
    setTimeout(notifyNow, 1200);
    setTimeout(notifyNow, 3500);
  }

  function hookHistoryMethod(method) {
    const orig = history[method];
    if (typeof orig !== "function") return;
    history[method] = function (...args) {
      const result = orig.apply(this, args);
      onRouteChange();
      return result;
    };
  }

  hookHistoryMethod("pushState");
  hookHistoryMethod("replaceState");

  window.addEventListener("hashchange", onRouteChange);
  window.addEventListener("popstate", onRouteChange);

  if (document.readyState === "complete") {
    reportPageVisit();
  } else {
    window.addEventListener("load", reportPageVisit);
  }

  let lastPolledHref = location.href;
  let lastPolledTitle = document.title;
  setInterval(() => {
    if (location.href !== lastPolledHref) {
      lastPolledHref = location.href;
      lastPolledTitle = document.title;
      onRouteChange();
      return;
    }
    const title = pageTitle();
    if (title && title !== lastPolledTitle) {
      lastPolledTitle = title;
      const best = pickBestM3u8(m3u8Urls);
      const folder = best ? videoFolderFromUrl(best) : activeVideoFolder;
      if (folder && folder !== activeVideoFolder) {
        if (activeVideoFolder) purgeFolder(activeVideoFolder);
        activeVideoFolder = folder;
        notifyNow();
      }
    }
  }, 800);

  watchVideoElements();

  try {
    const po = new PerformanceObserver((list) => {
      if (!isExtensionAlive()) return;
      for (const entry of list.getEntries()) {
        trackUrl(entry.name);
      }
    });
    po.observe({ type: "resource", buffered: true });
  } catch (_) {
    /* unavailable in some frames */
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!isExtensionAlive()) return false;

      if (msg.type === "getStreamState") {
        const best = pickBestM3u8(m3u8Urls);
        const streamMeta = collectStreamMetadata(best);
        sendResponse({
          m3u8Url: best,
          m3u8Urls: [...m3u8Urls],
          sampleTsUrl,
          pageUrl: location.href,
          title: streamMeta.title,
          pageTitle: streamMeta.pageTitle,
          thumbnailUrl: streamMeta.thumbnailUrl,
          thumbnailDataUrl: streamMeta.thumbnailDataUrl,
          duration: streamMeta.duration,
          videoWidth: streamMeta.videoWidth,
          videoHeight: streamMeta.videoHeight,
        });
        return true;
      }

      if (msg.type === "captureVideoThumbnail") {
        const video = getActiveVideo();
        sendResponse({
          dataUrl: captureVideoFrameDataUrl(video),
          thumbnailUrl: resolveThumbnailUrl(video, pickBestM3u8(m3u8Urls)),
        });
        return true;
      }
      return false;
    });
  } catch {
    markDead();
  }
})();
