# G-Follow Inspector (Chrome Extension)

G-Follow Inspector helps you quickly identify accounts that don’t follow you back on Instagram by comparing your followers and following lists. Run a scan, track progress in real time, and get a clear, easy-to-read result.

## Features
- One-click scan (docked worker window opens on the right).
- Who doesn’t follow you back (non-followers).
- Followers vs. following comparison.
- Progress screen while scanning.
- Clear results list you can review anytime.
- Export results to CSV (both “They follow, I don’t” and “I follow, they don’t” in one file).

## Requirements
- Chromium-based browser with extension support (Chrome, Edge, Brave).
- You must be logged into Instagram in the same browser profile.

## Install (load unpacked)
1) `git clone` this repo.
2) In Chrome: `chrome://extensions` → Enable **Developer mode**.
3) Click **Load unpacked** and select the project folder.
4) Pin the extension (optional).

## Usage
1) Open Instagram in a tab (stay logged in).
2) Click the extension icon → **Scan**.
   - A worker window opens on the right; don’t minimize it while it runs.
3) Wait for progress to reach 100%. The popup will show:
   - Accounts you follow that don’t follow you back.
   - Accounts that follow you but you don’t follow back.
4) Use **Copy** to copy the JSON results; review the lists in the popup.

### Notes
- If a list is very short, Instagram may render it without scroll; the extension auto-detects both scrollable and non-scrollable modals.
- Keep the worker window visible; minimizing can pause loading.
- Not affiliated with Instagram or Meta.

## Privacy & Data
- The extension reads followers/following only on `instagram.com`.
- Data stays local in `chrome.storage`; nothing is sent to external servers.
- No passwords, cookies or tokens are collected.
- Provide a privacy policy URL in the Chrome Web Store listing (recommended/required).

## Development
Files of interest:
- `content.js`: scraping, overlay, scroll handling.
- `background.js`: service worker, docking logic, messaging, state.
- `popup/`: UI, logs, actions.

To reload during dev: open `chrome://extensions`, click **Reload** on the extension, then reopen the popup and re-run a scan.

## Troubleshooting
- **Stuck at 0% / “container not found”**: ensure the Instagram modal is open and not covered; keep the worker window visible.
- **Counts look wrong on very small lists**: rerun once; the script now retries and falls back to textual parsing when Instagram omits anchor tags.
- **Unfollow not clicking**: ensure the profile page is fully loaded; if the modal doesn’t show “Unfollow/Dejar de seguir”, retry manually once.

## Permissions
- `storage`, `tabs`, `windows`, host `https://www.instagram.com/*`.