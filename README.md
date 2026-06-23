# Video Downloader

Chrome extension + local **ffmpeg** helper to detect **HLS** streams (`.m3u8`) on websites you visit and save them as `.mp4` files on your computer.

> **Legal:** Only download content you are allowed to save (your own videos, licensed material, explicit permission, etc.). This tool is for personal use with streams your browser can already play; authors are not responsible for misuse.

## Features

- Detects HLS while you **play** a video (XHR / fetch / performance hooks)
- Side panel: **Detect**, **This page**, **Downloads**
- Quality selection when a master playlist is available
- **Settings → Default video quality**: auto-pick best, lowest, or a target resolution (1080p / 720p / etc.) when streams are detected
- Bulk download with per-video and **overall queue progress** (e.g. 3 of 10 · 28%)
- Unique filenames (`Title__{id}.mp4`) — no accidental overwrites
- **Sync disk**: reconnect history to files, detect deleted files, re-download

## Requirements

| Component | Version |
|-----------|---------|
| Google Chrome | Recent stable |
| Python | 3.10+ |
| ffmpeg | On `PATH` ([install](https://ffmpeg.org/)) — e.g. `winget install Gyan.FFmpeg` |
| OS (native host) | **Windows** (`install.ps1`) |

The extension loads on any site; the Python native host installer is **Windows-only** today. On Linux/macOS you could register `host.py` manually with Chrome’s [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) docs.

## Quick start

### 1. Clone and icons (optional)

Icons are included. To regenerate:

```powershell
pip install -r requirements-dev.txt
python scripts/generate_icons.py
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Copy the **Extension ID**

### 3. Install the native host (Windows)

```powershell
cd native-host
.\install.ps1 -ExtensionId "YOUR_EXTENSION_ID_HERE"
```

This registers `com.videodownloader.nativehost` in Chrome and writes `com.videodownloader.nativehost.installed.json` locally — **do not commit that file**.

### 4. Reload the extension

Open the side panel, set your **download folder**, play a video, then download.

## Usage

1. Browse a site with HLS video and **start playback**.
2. Open the **side panel** (toolbar icon).
3. Set **Download folder**.
4. Pick quality if shown → **Download selected**.
5. **Downloads** tab: play file, open folder, **Sync disk**, re-download if a file was removed.

### File naming

- Videos are saved under a **subfolder per visited page** (auto-named from the URL, or a name you choose in the Videos tab)
- Renaming a page folder **moves existing `.mp4` files** into the new subfolder automatically
- **Rename individual videos** in the list; saved files are renamed on disk (keeps the stable `__tag` suffix)
- Example: `DownloadFolder/My Course/Video Title__tag.mp4`
- `Video Title__a1b2c3d4.mp4` — stable ID suffix per item
- Re-download with file present → new name with `_redl…` suffix (no overwrite)
- Deleted file → status resets; download again from **Downloads**

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Helper not connected | Run `install.ps1` with the correct Extension ID; reload extension |
| No m3u8 detected | Play the video; DevTools → Network → filter `m3u8` |
| ffmpeg 403 / denied | Log in on the site; replay the video |
| ffmpeg not found | Install ffmpeg; restart Chrome |
| Done but file missing | **Downloads** → **Sync disk** → **Download** |
| Extension ID changed | Re-run `install.ps1` with the new ID |

## Project layout

```
extension/          Chrome MV3 extension (load unpacked)
native-host/        Python native messaging host + Windows install script
scripts/            Icon generator
```

## Development

- **Extension:** edit under `extension/`, reload on `chrome://extensions`
- **Native host:** edit `native-host/host.py` / `downloader.py`, re-run `install.ps1` if paths change
- **Privacy:** history and settings stay in `chrome.storage.local`; videos save only to your chosen folder

## License

[MIT](LICENSE)
