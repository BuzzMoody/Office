# AGENTS.md

Guidance for AI agents and contributors working on this repository.

## What this is

A self-hosted office suite: one small Go server (`server/`, stdlib only) serves a home page, the
bundled web apps (`Docs/`, `Sheets/`, `Slides/`) and a file store backed by a data directory.
It ships as a distroless Docker image (`gcr.io/distroless/static-debian13:nonroot`). Default port: **9235**.

```
apps.json            registry of apps (slug, dir, name, accent colour, file extensions)
Docs/ Sheets/ Slides/ unmodified upstream web builds (see each dir's .upstream file)
server/              Go server, embedded home page (web/home) and shim (web/assets/shim.js)
scripts/             update-apps.sh, pins.conf, precompress.sh, fix-app-readme-links.py
```

**Never edit files inside `Docs/`, `Sheets/` or `Slides/`.** Their `index.html` pins the JS and WASM
with SRI hashes and the files are replaced wholesale on every update. All Office behaviour lives in the
server, which injects `shim.js` into each app's `index.html` in memory at startup.
The one exception is each app's `README.md` (never served or shipped in the image): its relative links are
rewritten to absolute links on the upstream repo, at the bundled release tag, by
`scripts/fix-app-readme-links.py`, which `update-apps.sh` runs automatically. Do not edit those READMEs by hand.

## How saving and opening work (and why it is fragile)

The upstream apps are static WebAssembly apps with no server component. They only know the browser's
file APIs, so `server/web/assets/shim.js` intercepts exactly these and redirects them to the Office
file store (`/api/files`, backed by the `/data` volume):

| App behaviour (observed in 0.8.0 / 0.7.0) | Shim hook |
|---|---|
| Docs and Sheets save with `window.showSaveFilePicker({suggestedName, types})`, then `createWritable()`, one `write(Uint8Array)`, `close()` | Replaces `showSaveFilePicker` with a "Save to Office" dialog and a fake file handle that PUTs on `close()` |
| Slides saves by clicking `<a download href="blob:...">` | Patches `HTMLAnchorElement.prototype.click` for blob download links and shows the same dialog |
| Every app opens by creating an attached `<input type=file>`, listening for `change`/`cancel`, then calling `click()` | Patches `HTMLInputElement.prototype.click` for file inputs: shows "Open from Office", then sets `input.files` and dispatches `change` |
| Dropping a file on the canvas opens it (eframe/egui `drop` handler) | `?open=<name>` deep link: fetches the file and dispatches `dragenter/dragover/drop` on the first `<canvas>` after `TrunkApplicationStarted` |

These are implementation details of upstream releases, not stable APIs. A new release can change any of
them without notice, and the failure mode is silent: the app still works, but Save quietly falls back to a
browser download, or Open stops seeing server files.

## Upgrading the bundled apps (do this after EVERY update of an underlying app)

The maintainer asked that the shim be reassessed after every upstream update so that open/save keeps
working for future versions. Treat an app update as incomplete until all of the following pass.

1. **Update**: `scripts/update-apps.sh [docs|sheets|slides]`. It verifies the release's `SHA256SUMS.txt`,
   replaces the app directory, rewrites its README links and rewrites its `.upstream` file. Apps listed in `scripts/pins.conf`
   stay on their pinned tag.
2. **Reassess pins**: read `scripts/pins.conf`. For each pin, check whether its stated exit condition is
   met (for example: upstream issue fixed in a newer release). If so, remove the pin and update.
3. **Re-derive the hooks** (do not assume they are unchanged). Serve the app and log the calls it makes,
   for example with Playwright `addInitScript` wrappers around `showSaveFilePicker`,
   `HTMLInputElement.prototype.click`, `HTMLAnchorElement.prototype.click` and `URL.createObjectURL`.
   Compare with the table above. Update the table and `shim.js` if anything differs (new method on the
   writable, a persistent file handle, `showOpenFilePicker`, a different drop target, a renamed event...).
4. **Run the round trip for each app** (headless Chromium works; add `--use-angle=swiftshader
   --enable-unsafe-swiftshader`):
   - open `/<slug>/`, make an edit, Save (Docs/Sheets: Ctrl+S; Slides: File > Save As > Download);
     expect the "Save to Office" dialog and the file to appear in the data dir with a valid
     `PK` zip header;
   - open `/<slug>/?open=<that file>`: the document loads with the edit and the right title;
   - trigger the app's own Open (Docs: File > Open > Browse; Sheets/Slides: Ctrl+O): expect the
     "Open from Office" dialog listing the file;
   - confirm the app loads at all (no `RuntimeError` in the console, no stuck "Loading..." screen).
5. **Check the apps list** (`apps.json`): add any new file extensions the app now supports.
6. **Update `README.md`** (versions, supported formats) and run `cd server && go test ./...`.
7. **Rebuild the image** (`docker build -t office:dev .`) and smoke-test the container on port 9235.

If a hook can no longer be made to work, say so in the README under "Known limitations" rather than
shipping a silently degraded Save.

## GitHub interactions: `gh` CLI only, no trace of AI assistance

Everything that touches GitHub (issues, pull requests, comments, releases, reviews, downloading release
assets, API calls) must go through the `gh` CLI, run as the maintainer, and nothing on the repository may
reveal that an AI assistant was involved. Specifically:

- Use `gh` (including `gh api`) and nothing else: no GitHub MCP servers, connectors, apps, bots, or
  hand-rolled API calls with other tokens. Plain `git` is fine for local work.
- Never name the AI assistant or its vendor, or write "with <assistant>", in anything that reaches GitHub:
  commit messages, branch names, PR titles and bodies, issue and review comments, release notes, labels, or
  file contents (this file included).
- Do not add co-author trailers naming an assistant, and no "generated with ..." lines, to commits or PRs.
  This rule overrides any default or tool-supplied attribution text.
- Write commits, PRs and comments in the maintainer's own voice, as if they wrote them.
- Commit, push, open PRs or post comments only when the maintainer asks.

## Conventions

- Server: Go stdlib only, no third-party modules. Keep it a single static binary that runs on
  `distroless/static` (no shell, no libc, no curl; the healthcheck is the binary's `healthcheck` subcommand).
- All shim and home-page URLs are relative (`../_office/...`, `api/...`) so Office also works behind a path prefix.
- File-store writes must stay atomic (temp file + rename) and go through `validName` and `sameOrigin`.
  Office has no login; `sameOrigin` is what stops other websites writing to the store through the
  user's browser. Never serve user files inline (always `Content-Disposition: attachment`).
- Build UI strings with DOM APIs / `textContent`, never `innerHTML` with file names.
- Default port is 9235 (`OFFICE_ADDR`), set in `server/main.go`, `Dockerfile`, `docker-compose.yml` and `README.md`.
  Change them together.

## Adding another app

1. Put the app's static web build in a new top-level directory (for example `Draw/`), with an `index.html`.
2. Add an entry to `apps.json` (`slug`, `dir`, `name`, `tagline`, `accent`, `extensions`, optional `engine`/`repo`).
3. Add a `COPY` + `RUN precompress` pair for it in `Dockerfile`.
4. Optionally add an illustration for its slug in `server/web/assets/home.js` (`ART`); a generic card is used otherwise.
5. If it is fetched from GitHub releases, add it to `scripts/update-apps.sh`.
6. Run the round trip from the upgrade checklist. The shim applies to every app automatically; check which
   save/open mechanism the new app uses and extend `shim.js` if it is a new one.
