# Security

## Reporting a vulnerability

If you find a security issue, please **open a private report** via GitHub Security Advisories on this repository, or email the maintainer listed on the GitHub profile. Do not open a public issue for exploitable vulnerabilities.

## Scope

This project runs **locally** on your machine:

- The Chrome extension talks only to a **native messaging host** you install (`native-host/host.py`).
- Downloads are written to a folder **you choose** in the side panel.
- The extension uses site cookies only to pass through to **ffmpeg** for the same-origin HLS URLs you are already playing in the browser.

There is no remote server operated by this project.

## Safe use

- Install the native host only from this repository’s `install.ps1` after reviewing the scripts.
- Do not commit `native-host/com.waelacademy.downloader.installed.json` (generated locally; listed in `.gitignore`).
