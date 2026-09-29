# RoLink Bridge — Figma plugin

AI web chat → Figma → Roblox Studio. The Figma plugin polls the local bridge
(`http://127.0.0.1:3001/queue/next?client=figma`) and executes `figma_*` tools
via the Figma Plugin API. No account token, no cloud, no cost.

## Install (Figma Desktop required)

Figma web may block `localhost` fetch. Use the Desktop app.

1. Run the bridge: double-click `start.bat` (Windows) in the release folder.
2. In Figma Desktop: **Plugins → Development → Import plugin from manifest…**
3. Select `figma-plugin/manifest.json` from this release folder.
4. **Plugins → Development → RoLink Bridge** to open it.
5. The dot turns green: `Connected — waiting for commands`.

Keep the plugin window open while using `figma_*` tools. Closing it stops
polling (the bridge reports `figma_status: no-plugin`).

## Use

In your AI chat (DeepSeek recommended), with a session started:

- `figma_create_frame{title, width, height}` — new Frame, centred on viewport.
- `figma_create_node{parentId, type, ...}` — child inside a frame: `TEXT` (with `characters`/`fontSize`, font auto-loaded), `RECTANGLE`, `ELLIPSE`, or `FRAME` (with `bounds` parent-relative, `fills`, `cornerRadius`, `opacity`).
- Full CRUD: `figma_delete_node`, `figma_duplicate_node`, `figma_move_node` (reparent/reorder), `figma_resize_node`.
- Text: `figma_set_text`, `figma_set_font` (family/style/size).
- Style: `figma_set_stroke`, `figma_set_shadow`, `figma_set_blur`, `figma_set_constraint`, `figma_set_visible`, `figma_set_locked`, `figma_set_clips`, `figma_set_min_max`.
- Layout: `figma_set_auto_layout`, `figma_set_padding`, `figma_set_axis`, `figma_set_counter_axis`, `figma_set_primary_axis`, `figma_set_resize` (hug/fill/fixed).
- Arrange: `figma_group_nodes`, `figma_ungroup`, `figma_align_nodes`, `figma_distribute_nodes`.
- Components: `figma_create_component`, `figma_create_instance`, `figma_detach_instance`, `figma_set_variant`.
- Data/prototype: `figma_set_plugin_data`, `figma_get_plugin_data`, `figma_set_reactions`.
- Images (bytes only, no URL fetch): `figma_import_image`, `figma_set_image_fill`.
- Export: `figma_create_slice`, `figma_set_export_settings`.
- `figma_get_nodes{nodeId?}` — node tree (selection or page when omitted).
- `figma_set_properties{nodeId, fills, cornerRadius, layoutMode, …}` — restyle.
- `figma_export_node{nodeId, format: PNG|SVG|PDF|JPG, scale}` — base64 bytes.
- `figma_get_document{}` — file, pages, selection.
- `create_ui_from_figma{figmaNodeId}` — runs in **Studio**, not Figma.

Check health first: `figma_status` (verdicts `healthy / executing /
no-plugin / plugin-stale / stuck-execution / no-queue`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red dot, `Bridge offline` | Run `start.bat`; check the Bridge window shows `Studio queue listening on :3001` |
| Green dot but AI says `no-plugin` | The plugin window must stay open; reopen it |
| `export too large` | Lower `scale` (try 1) or export a smaller node |
| `VERSION MISMATCH` in bridge log | Reinstall the plugin from this release folder |
| Web Figma fails, Desktop works | Expected — web sandbox blocks localhost |

## Dev notes

- `code.js` runs in the sandbox (Figma API only, no network).
- `ui.html` owns polling + base64 + result POSTs (reliable fetch).
- Poll interval `200ms`, single-flight, `25s` sandbox watchdog.
- Result body cap `10MB` (bridge-enforced); exports over `8MB` are refused
  client-side with a clear error.
- Version: `FIGMA_PLUGIN_VERSION` in both files must match.
