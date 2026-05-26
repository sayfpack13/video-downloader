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

  function pickBestM3u8(urls) {
    const list = [...urls];
    const master = list.find((u) => /\/playlist\.m3u8/i.test(u));
    if (master) return master;
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

  function pageTitle() {
    const h1 = document.querySelector("h1, h2, [class*='title']");
    return (h1 && h1.textContent.trim()) || document.title || "Video";
  }

  function getPlayerDuration() {
    const videos = document.querySelectorAll("video");
    let best = 0;
    for (const v of videos) {
      const d = v.duration;
      if (d && Number.isFinite(d) && d > best) best = d;
    }
    return best > 0 ? Math.round(best) : null;
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
      video.addEventListener("loadeddata", () => notify());
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

    let m3u8Url = pickBestM3u8(m3u8Urls);
    if (!m3u8Url && sampleTsUrl) {
      m3u8Url = playlistCandidatesFromTs(sampleTsUrl)[0] || null;
    }

    const folder = m3u8Url ? videoFolderFromUrl(m3u8Url) : null;
    const folderChanged =
      folder && lastNotifiedFolder && folder !== lastNotifiedFolder;
    if (folder) lastNotifiedFolder = folder;

    safeSendMessage({
      type: "streamDetected",
      payload: {
        m3u8Url,
        m3u8Candidates: [...m3u8Urls],
        sampleTsUrl,
        pageUrl: location.href,
        title: pageTitle(),
        duration: getPlayerDuration(),
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

  function trackUrl(url) {
    if (!isExtensionAlive() || !url || typeof url !== "string") return;
    if (isM3u8(url)) {
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
    } else if (isTs(url)) {
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
      payload: { pageUrl: href, title: pageTitle() },
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
        sendResponse({
          m3u8Url: pickBestM3u8(m3u8Urls),
          m3u8Urls: [...m3u8Urls],
          sampleTsUrl,
          pageUrl: location.href,
          title: pageTitle(),
          duration: getPlayerDuration(),
        });
        return true;
      }
      return false;
    });
  } catch {
    markDead();
  }
})();
