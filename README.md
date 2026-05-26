# Video Downloader

Chrome extension + local helper to detect HLS streams (`.m3u8` / `.ts`) on **any website** and bulk-download videos as `.mp4` files using **ffmpeg**.

Only **detected video streams** appear in the list — not course pages, catalogs, or lesson listings.

## Requirements

- Google Chrome
- Python 3.10+
- [ffmpeg](https://ffmpeg.org/) (install via `winget install Gyan.FFmpeg`)

## Setup

### 1. Extension icons (first time)

```powershell
pip install pillow
python scripts/generate_icons.py
```

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Copy the **Extension ID**

### 3. Install the native host

```powershell
cd native-host
.\install.ps1 -ExtensionId "YOUR_EXTENSION_ID_HERE"
```

### 4. Reload the extension

## Usage

1. Browse any site with HLS video (courses, streaming, etc.).
2. Open the **side panel** (extension icon).
3. Set your **Download folder**.
4. **Play a video** — a card appears when the stream is detected.
5. Use **Detect** or **This page**, pick quality, then **Download selected**.
6. Open **Downloads** to play files, open the folder, or **Sync disk** to match history with files on disk.

### File naming

Saved files look like `Video Title__a1b2c3d4.mp4`. The suffix is a stable ID from the extension so:

- Two videos with the same title do **not** overwrite each other
- After you delete a file, the **Downloads** tab shows “Removed from disk” and you can download again (new file, same tag or a `_redl` suffix if needed)
- **Re-download** on an existing file saves a new copy (`_redl2_…`) instead of overwriting
- Orphan `.mp4` files in the folder can be linked back to history by tag when you sync

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Helper not connected | Run `install.ps1` with the correct Extension ID; reload extension |
| No m3u8 detected | Play the video; check DevTools → Network for `.m3u8` |
| ffmpeg 403 | Log in on the site if required; replay the video |
| ffmpeg not found | Install ffmpeg and restart Chrome |
| Marked Done but file missing | **Downloads** → **Sync disk** → **Download** |

## Project layout

```
extension/          Chrome MV3 extension (load unpacked)
native-host/        Python native messaging host + install.ps1
scripts/            Utility scripts
```

## Re-install after extension ID changes

If you remove and re-add the unpacked extension, run `install.ps1` again with the new ID.
