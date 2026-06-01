#!/usr/bin/env python3
"""Chrome native messaging host for bulk HLS downloads."""

from __future__ import annotations

import json
import os
import platform
import struct
import subprocess
import sys
from pathlib import Path

from downloader import (
    build_download_path,
    download_hls,
    ffmpeg_version,
    migrate_page_folder,
    parse_tag_from_filename,
    rename_video_file,
)


def read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) == 0:
        return None
    length = struct.unpack("@I", raw_len)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(msg: dict) -> None:
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def open_in_os(path: Path) -> None:
    path = path.expanduser()
    system = platform.system()
    if system == "Windows":
        os.startfile(str(path))  # noqa: S606
    elif system == "Darwin":
        subprocess.run(["open", str(path)], check=False)
    else:
        subprocess.run(["xdg-open", str(path)], check=False)


def handle_ping() -> None:
    send_message({"ok": True, "status": "ok", "ffmpeg": ffmpeg_version()})


def handle_download(msg: dict) -> None:
    output_dir = Path(msg.get("outputDir") or "").expanduser()
    if not str(output_dir):
        output_dir = Path.home() / "Videos" / "Downloads"
    output_dir.mkdir(parents=True, exist_ok=True)

    items = msg.get("items") or []
    for idx, item in enumerate(items):
        item_id = item.get("id", "") or str(idx)
        title = item.get("title", "video")
        m3u8 = item.get("m3u8Url")
        referer = item.get("referer") or ""
        cookies = item.get("cookieHeader", "")
        video_id = item.get("videoId") or ""
        existing_path = item.get("existingPath") or item.get("file") or ""
        force_new = bool(item.get("forceNew"))

        if not m3u8:
            send_message({
                "id": item_id,
                "status": "error",
                "title": title,
                "message": "Missing m3u8 URL",
            })
            continue

        out_file = build_download_path(
            output_dir,
            title,
            item_id,
            video_id=video_id or None,
            page_url=referer or None,
            folder_name=item.get("folderName") or None,
            existing_path=existing_path or None,
            force_new=force_new,
        )

        def progress_cb(percent: int, label: str, _id=item_id, _title=title) -> None:
            send_message({
                "id": _id,
                "status": "downloading",
                "title": _title,
                "progress": percent,
                "progressLabel": label,
            })

        send_message({
            "id": item_id,
            "status": "downloading",
            "title": title,
            "progress": 0,
            "progressLabel": "Starting…",
        })

        try:
            download_hls(m3u8, referer, out_file, cookies, on_progress=progress_cb)
            if not out_file.exists() or out_file.stat().st_size < 1024:
                raise RuntimeError("Output file missing or too small after download")
            send_message({
                "id": item_id,
                "status": "done",
                "title": title,
                "progress": 100,
                "progressLabel": "Done",
                "file": str(out_file.resolve()),
                "fileSize": out_file.stat().st_size,
            })
        except Exception as e:
            send_message({
                "id": item_id,
                "status": "error",
                "title": title,
                "message": str(e),
            })

    send_message({"type": "complete"})


def handle_list_dir(msg: dict) -> None:
    output_dir = Path(msg.get("outputDir") or "").expanduser()
    if not output_dir.is_dir():
        send_message({"ok": True, "files": [], "outputDir": str(output_dir)})
        return

    files = []
    for path in sorted(output_dir.rglob("*.mp4")):
        try:
            st = path.stat()
            try:
                rel_folder = str(path.parent.relative_to(output_dir))
                if rel_folder == ".":
                    rel_folder = ""
            except ValueError:
                rel_folder = ""
            files.append({
                "name": path.name,
                "path": str(path.resolve()),
                "folder": rel_folder,
                "size": st.st_size,
                "mtime": int(st.st_mtime * 1000),
            })
        except OSError:
            continue

    files.sort(key=lambda f: f["mtime"], reverse=True)
    for entry in files:
        entry["fileTag"] = parse_tag_from_filename(entry["name"])
    send_message({"ok": True, "files": files, "outputDir": str(output_dir.resolve())})


def handle_stat_files(msg: dict) -> None:
    results = []
    for path_str in msg.get("paths") or []:
        path = Path(path_str).expanduser()
        exists = path.is_file()
        size = path.stat().st_size if exists else 0
        results.append({"path": str(path), "exists": exists, "size": size})
    send_message({"ok": True, "results": results})


def handle_open_path(msg: dict) -> None:
    path = Path(msg.get("path") or "").expanduser()
    if not path.exists():
        send_message({"ok": False, "error": "Path not found"})
        return
    open_in_os(path)
    send_message({"ok": True})


def handle_rename_video_file(msg: dict) -> None:
    result = rename_video_file(
        msg.get("path") or "",
        msg.get("title") or "",
        msg.get("itemId") or msg.get("id") or "",
        msg.get("videoId") or None,
    )
    send_message(result)


def handle_migrate_page_folder(msg: dict) -> None:
    output_dir = Path(msg.get("outputDir") or "").expanduser()
    if not output_dir.is_dir():
        send_message({"ok": False, "error": "Download folder not found"})
        return
    result = migrate_page_folder(
        output_dir,
        msg.get("fromFolder") or "",
        msg.get("toFolder") or "",
    )
    send_message(result)


def handle_open_folder(msg: dict) -> None:
    raw = msg.get("path") or msg.get("outputDir") or ""
    path = Path(raw).expanduser()
    folder = path if path.is_dir() else path.parent
    if not folder.is_dir():
        send_message({"ok": False, "error": "Folder not found"})
        return
    open_in_os(folder)
    send_message({"ok": True, "folder": str(folder.resolve())})


def main() -> None:
    msg = read_message()
    if not msg:
        return
    cmd = msg.get("cmd")
    handlers = {
        "ping": handle_ping,
        "download": handle_download,
        "listDir": handle_list_dir,
        "statFiles": handle_stat_files,
        "openPath": handle_open_path,
        "openFolder": handle_open_folder,
        "migratePageFolder": handle_migrate_page_folder,
        "renameVideoFile": handle_rename_video_file,
    }
    handler = handlers.get(cmd)
    if handler:
        handler(msg)
    else:
        send_message({"ok": False, "error": f"Unknown command: {cmd}"})


if __name__ == "__main__":
    main()
