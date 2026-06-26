# UGREEN NAS Sync for Obsidian

Minimal Obsidian plugin for syncing vault files with a UGREEN NAS running UGOS Pro.

## Scope

- Supports UGREEN NAS only.
- Supports direct UGOS URL or UGREENlink ID login.
- Runs two-way sync from the status bar, command palette, or settings tab.
- Optional automatic sync with configurable intervals (1–60 minutes).
- Always syncs the whole vault.
- Does not support encryption, multiple providers, OAuth, S3, WebDAV, or OneDrive.

## Safety

- The first sync never treats missing files as deletes because no prior sync state exists.
- Later syncs use local sync history to detect deletes.
- Remote deletes use the UGOS trash operation instead of permanent deletion.
- If both sides changed with different content, the plugin keeps a local conflict copy before downloading the remote file.

## Development

```bash
npm install
npm run build
```

The built plugin entry is `main.js`; Obsidian also loads `manifest.json` and `styles.css` from this directory.
