# UGREEN NAS Sync for Obsidian

Minimal Obsidian plugin for syncing vault files with a UGREEN NAS running UGOS Pro.

## Scope

- Supports UGREEN NAS only.
- Supports direct UGOS URL or UGREENlink ID login.
- Runs manual two-way sync from the ribbon icon, command palette, or settings tab.
- Lets you sync the whole vault or selected local folders.
- Does not support encryption, multiple providers, scheduled sync, OAuth, S3, WebDAV, or OneDrive.

## Safety

- The first sync never treats missing files as deletes because no prior sync state exists.
- Later syncs use local sync history to detect deletes.
- Remote deletes use the UGOS trash operation instead of permanent deletion.
- If both sides changed and the remote file is newer, the plugin keeps a local conflict copy before downloading the remote file.
- The plugin skips its own plugin folder under Obsidian's config directory so it does not upload its own `data.json` password storage.

## Development

```bash
npm install
npm run build
```

The built plugin entry is `main.js`; Obsidian also loads `manifest.json` and `styles.css` from this directory.
