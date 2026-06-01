"""ffmpeg HLS download helpers."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

ProgressCallback = Callable[[int, str], None]

def _ffmpeg_candidates() -> list[Path]:
    candidates: list[Path] = []
    which = shutil.which("ffmpeg")
    if which:
        candidates.append(Path(which))

    local = Path(os.environ.get("LOCALAPPDATA", ""))
    for pattern in [
        Path(r"C:\ffmpeg\bin\ffmpeg.exe"),
        Path(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"),
        local / "Microsoft" / "WinGet" / "Links" / "ffmpeg.exe",
    ]:
        candidates.append(pattern)

    winget_packages = local / "Microsoft" / "WinGet" / "Packages"
    if winget_packages.is_dir():
        for exe in winget_packages.glob("Gyan.FFmpeg*/ffmpeg-*/bin/ffmpeg.exe"):
            candidates.append(exe)

    return candidates


def find_ffmpeg() -> str:
    seen: set[str] = set()
    for path in _ffmpeg_candidates():
        key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        if path.is_file():
            return str(path)
    raise RuntimeError(
        "ffmpeg not found. Install: winget install Gyan.FFmpeg — then restart Chrome."
    )


def find_ffprobe() -> str:
    ffmpeg = Path(find_ffmpeg())
    probe = ffmpeg.parent / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if probe.is_file():
        return str(probe)
    which = shutil.which("ffprobe")
    if which:
        return which
    raise RuntimeError("ffprobe not found next to ffmpeg")


def _build_headers(referer: str, cookie_header: str) -> str:
    headers = f"Referer: {referer}\r\n"
    if cookie_header:
        headers += f"Cookie: {cookie_header}\r\n"
    try:
        from urllib.parse import urlparse

        origin = urlparse(referer).scheme + "://" + urlparse(referer).netloc
        if origin and origin != "://":
            headers += f"Origin: {origin}\r\n"
    except Exception:
        pass
    return headers


def _format_timestamp(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def probe_duration(m3u8_url: str, referer: str, cookie_header: str = "") -> float | None:
    try:
        ffprobe = find_ffprobe()
        headers = _build_headers(referer, cookie_header)
        cmd = [
            ffprobe,
            "-v",
            "error",
            "-headers",
            headers,
            "-i",
            m3u8_url,
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            return None
        value = (result.stdout or "").strip()
        if value:
            dur = float(value)
            return dur if dur > 0 else None
    except Exception:
        pass
    return None


def normalize_page_url(url: str) -> str:
    """Match extension background normalizePageUrl for stable folder names."""
    url = (url or "").strip()
    if not url:
        return ""
    try:
        u = urlparse(url)
        if u.fragment and u.fragment.startswith("/"):
            return f"{u.scheme}://{u.netloc}{u.path or ''}{u.fragment}"
        path = (u.path or "/").rstrip("/") or "/"
        base = f"{u.scheme}://{u.netloc}{path}"
        return f"{base}?{u.query}" if u.query else base
    except Exception:
        return url


def sanitize_user_folder_name(name: str) -> str:
    """User-chosen folder label (spaces allowed)."""
    name = (name or "").strip()
    if not name:
        return ""
    name = re.sub(r'[<>:"/\\|?*]', "_", name)
    name = re.sub(r"\s+", " ", name).strip()
    name = re.sub(r"_+", "_", name).strip("._")
    return name[:120]


def resolve_page_folder_name(page_url: str | None, folder_name: str | None = None) -> str | None:
    """Effective subfolder under output_dir."""
    custom = sanitize_user_folder_name(folder_name or "")
    if custom:
        return custom
    if page_url:
        return folder_name_from_page_url(page_url)
    return None


def migrate_page_folder(output_dir: Path, from_folder: str, to_folder: str) -> dict:
    """Move all .mp4 files from one page subfolder to another."""
    from_name = sanitize_user_folder_name(from_folder) or (from_folder or "").strip()
    to_name = sanitize_user_folder_name(to_folder) or (to_folder or "").strip()
    if not from_name or not to_name:
        return {"ok": False, "error": "Invalid folder name"}
    if from_name == to_name:
        return {"ok": True, "moved": 0, "fromFolder": from_name, "toFolder": to_name}

    from_path = output_dir / from_name
    to_path = output_dir / to_name
    if not from_path.is_dir():
        to_path.mkdir(parents=True, exist_ok=True)
        return {
            "ok": True,
            "moved": 0,
            "fromFolder": from_name,
            "toFolder": to_name,
            "note": "source missing",
        }

    to_path.mkdir(parents=True, exist_ok=True)
    moved = []
    for src in sorted(from_path.glob("*.mp4")):
        dest = to_path / src.name
        if dest.exists() and dest.resolve() != src.resolve():
            stem = dest.stem
            suffix = dest.suffix
            ts = int(time.time())
            for n in range(2, 100):
                candidate = to_path / f"{stem}_mv{n}_{ts}{suffix}"
                if not candidate.exists():
                    dest = candidate
                    break
        src.rename(dest)
        moved.append({"from": str(src.resolve()), "to": str(dest.resolve())})

    try:
        if from_path.is_dir() and not any(from_path.iterdir()):
            from_path.rmdir()
    except OSError:
        pass

    return {
        "ok": True,
        "moved": len(moved),
        "fromFolder": from_name,
        "toFolder": to_name,
        "files": moved,
    }


def folder_name_from_page_url(page_url: str) -> str:
    """Safe subdirectory name derived from the page URL."""
    norm = normalize_page_url(page_url) or (page_url or "").strip()
    if not norm:
        return "unknown-site"

    try:
        u = urlparse(norm)
        host = (u.hostname or "unknown").lower()
        host = re.sub(r"[^a-z0-9.-]", "_", host)

        if u.fragment and u.fragment.startswith("/"):
            path_part = u.fragment.split("?")[0]
            if u.path and u.path not in ("", "/"):
                path_part = u.path.rstrip("/") + path_part
        else:
            path_part = (u.path or "/")
            if u.query:
                path_part = f"{path_part}?{u.query}"

        path_part = path_part.strip("/") or "index"
        path_part = re.sub(r'[<>:"/\\|?*]', "_", path_part)
        path_part = re.sub(r"_+", "_", path_part).strip("_")[:64]

        url_hash = hashlib.sha1(norm.encode("utf-8")).hexdigest()[:8]
        if path_part and path_part != "index":
            name = f"{host}__{path_part}__{url_hash}"
        else:
            name = f"{host}__{url_hash}"
        name = re.sub(r"_+", "_", name).strip("_")
        return name[:120] or f"site__{url_hash}"
    except Exception:
        h = hashlib.sha1(norm.encode("utf-8")).hexdigest()[:8]
        return f"unknown-site__{h}"


def item_file_tag(item_id: str, video_id: str | None = None) -> str:
    tag = re.sub(r"[^a-f0-9]", "", (item_id or "").lower())[:8]
    if video_id:
        vid = re.sub(r"[^a-f0-9]", "", video_id.lower())
        uuid_part = vid[-8:] if len(vid) >= 8 else vid
        if uuid_part and uuid_part not in tag:
            tag = f"{tag}{uuid_part}"[:16]
    return tag or "video"


def safe_filename(title: str, file_tag: str = "") -> str:
    name = re.sub(r'[<>:"/\\|?*]', "_", title or "video").strip()
    name = re.sub(r"\s+", " ", name)[:120]
    if not name:
        name = "video"
    tag = re.sub(r"[^a-zA-Z0-9]", "", (file_tag or ""))[:16]
    if tag:
        return f"{name}__{tag}.mp4"
    return f"{name}.mp4"


def parse_tag_from_filename(filename: str) -> str | None:
    m = re.search(r"__([a-zA-Z0-9]{6,16})\.mp4$", filename, re.I)
    return m.group(1).lower() if m else None


def sanitize_video_title(title: str) -> str:
    return sanitize_user_folder_name(title) or "video"


def rename_video_file(
    file_path: str | Path,
    new_title: str,
    item_id: str,
    video_id: str | None = None,
) -> dict:
    path = Path(file_path).expanduser()
    if not path.is_file():
        return {"ok": False, "error": "File not found"}

    tag = parse_tag_from_filename(path.name) or item_file_tag(item_id, video_id)
    clean = sanitize_video_title(new_title)
    dest = path.parent / safe_filename(clean, tag)

    if dest.resolve() == path.resolve():
        return {"ok": True, "path": str(path.resolve()), "renamed": False, "title": clean}

    if dest.exists():
        stem = dest.stem
        suffix = dest.suffix
        ts = int(time.time())
        for n in range(2, 100):
            candidate = path.parent / f"{stem}_ren{n}_{ts}{suffix}"
            if not candidate.exists():
                dest = candidate
                break

    old = str(path.resolve())
    path.rename(dest)
    return {
        "ok": True,
        "path": str(dest.resolve()),
        "renamed": True,
        "from": old,
        "title": clean,
    }


def build_download_path(
    output_dir: Path,
    title: str,
    item_id: str,
    video_id: str | None = None,
    page_url: str | None = None,
    folder_name: str | None = None,
    existing_path: str | None = None,
    force_new: bool = False,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    tag = item_file_tag(item_id, video_id)

    if existing_path and not force_new:
        prev = Path(existing_path).expanduser()
        if prev.is_file() and prev.stat().st_size > 1024 * 50:
            return prev.resolve()

    dest_dir = output_dir
    sub = resolve_page_folder_name(page_url, folder_name)
    if sub:
        dest_dir = output_dir / sub
    dest_dir.mkdir(parents=True, exist_ok=True)

    path = dest_dir / safe_filename(title, tag)
    if not path.exists() or force_new:
        if force_new and path.exists():
            stem = path.stem
            suffix = path.suffix
            ts = int(time.time())
            for n in range(2, 100):
                candidate = dest_dir / f"{stem}_redl{n}_{ts}{suffix}"
                if not candidate.exists():
                    return candidate
        return path

    stem = path.stem
    suffix = path.suffix
    for n in range(2, 1000):
        candidate = dest_dir / f"{stem} ({n}){suffix}"
        if not candidate.exists():
            return candidate
    return dest_dir / safe_filename(f"{title} {int(time.time())}", tag)


def download_hls(
    m3u8_url: str,
    referer: str,
    output_path: Path,
    cookie_header: str = "",
    on_progress: ProgressCallback | None = None,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists() and output_path.stat().st_size > 1024 * 50:
        if on_progress:
            on_progress(100, "Already saved")
        return
    ffmpeg = find_ffmpeg()
    headers = _build_headers(referer, cookie_header)
    duration = probe_duration(m3u8_url, referer, cookie_header)

    if on_progress:
        on_progress(0, "Starting…")

    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-headers",
        headers,
        "-i",
        m3u8_url,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-progress",
        "pipe:2",
        "-nostats",
        str(output_path),
    ]

    proc = subprocess.Popen(
        cmd,
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )

    last_pct = -1
    out_time_ms = 0
    stderr_lines: list[str] = []

    assert proc.stderr is not None
    for line in proc.stderr:
        stderr_lines.append(line)
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, val = line.partition("=")
        if key == "out_time_ms" and val.isdigit():
            out_time_ms = int(val)
        elif key == "progress" and val == "end":
            break

        if duration and out_time_ms > 0 and on_progress:
            current = out_time_ms / 1_000_000
            pct = min(99, int(current / duration * 100))
            if pct != last_pct:
                last_pct = pct
                label = f"{_format_timestamp(current)} / {_format_timestamp(duration)}"
                on_progress(pct, label)
        elif not duration and on_progress and key == "out_time_ms" and out_time_ms > 0:
            current = out_time_ms / 1_000_000
            label = _format_timestamp(current)
            sec = int(current)
            if last_pct != sec:
                last_pct = sec
                on_progress(-1, label)  # -1 = indeterminate

    proc.wait()
    if proc.returncode != 0:
        err = "".join(stderr_lines).strip() or "ffmpeg failed"
        raise RuntimeError(err[-500:])

    if on_progress:
        on_progress(100, "Done")


def ffmpeg_version() -> str:
    try:
        ffmpeg = find_ffmpeg()
        r = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, timeout=10)
        first = (r.stdout or "").split("\n")[0]
        return first.replace("ffmpeg version ", "").split(" ")[0] if first else "unknown"
    except Exception:
        return "not found"
