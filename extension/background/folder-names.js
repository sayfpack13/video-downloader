/** Page subfolder naming — keep in sync with native-host/downloader.py */

function sha1Hex8(str) {
  // Compact SHA-1 for stable folder suffix (matches Python hashlib.sha1)
  const utf8 = new TextEncoder().encode(str);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = [];
  const bitLen = utf8.length * 8;
  for (let i = 0; i < utf8.length; i++) {
    words[i >> 2] |= utf8[i] << (24 - (i % 4) * 8);
  }
  words[bitLen >> 5] |= 0x80 << (24 - (bitLen % 32));
  words[(((bitLen + 64) >> 9) << 4) + 15] = bitLen;
  for (let i = 0; i < words.length; i += 16) {
    const w = new Array(80);
    for (let t = 0; t < 16; t++) w[t] = words[i + t] | 0;
    for (let t = 16; t < 80; t++) {
      w[t] = ((w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]) << 1) | ((w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]) >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t++) {
      let f;
      let k;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) | 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return (hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4)).slice(0, 8);
}

function normalizePageUrlForFolder(url) {
  url = (url || "").trim();
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.hash && u.hash.startsWith("/")) {
      return `${u.origin}${u.pathname || ""}${u.hash}`;
    }
    const path = (u.pathname || "/").replace(/\/$/, "") || "/";
    return u.search ? `${u.origin}${path}?${u.search}` : `${u.origin}${path}`;
  } catch {
    return url;
  }
}

function folderNameFromPageUrl(pageUrl) {
  const norm = normalizePageUrlForFolder(pageUrl) || (pageUrl || "").trim();
  if (!norm) return "unknown-site";

  try {
    const u = new URL(norm);
    let host = (u.hostname || "unknown").toLowerCase().replace(/[^a-z0-9.-]/g, "_");

    let pathPart;
    if (u.hash && u.hash.startsWith("/")) {
      pathPart = u.hash.split("?")[0];
      if (u.pathname && u.pathname !== "" && u.pathname !== "/") {
        pathPart = u.pathname.replace(/\/$/, "") + pathPart;
      }
    } else {
      pathPart = u.pathname || "/";
      if (u.search) pathPart = `${pathPart}?${u.search}`;
    }

    pathPart = (pathPart || "/").replace(/^\/+|\/+$/g, "") || "index";
    pathPart = pathPart.replace(/[<>:"/\\|?*]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 64);

    const urlHash = sha1Hex8(norm);
    let name =
      pathPart && pathPart !== "index" ? `${host}__${pathPart}__${urlHash}` : `${host}__${urlHash}`;
    name = name.replace(/_+/g, "_").replace(/^_|_$/g, "");
    return (name.slice(0, 120) || `site__${urlHash}`);
  } catch {
    const h = sha1Hex8(norm);
    return `unknown-site__${h}`;
  }
}

function sanitizeUserFolderName(name) {
  let s = (name || "").trim();
  if (!s) return "";
  s = s.replace(/[<>:"/\\|?*]/g, "_");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/_+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return s.slice(0, 120);
}

self.FolderNames = {
  normalizePageUrlForFolder,
  folderNameFromPageUrl,
  sanitizeUserFolderName,
};
