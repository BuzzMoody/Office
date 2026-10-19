# Office

A self-hosted, open-source office suite in one small Docker container: **Docs**, **Sheets** and **Slides**,
with a fast, animated home page and a shared file store on a volume you control. Everything runs in the
browser; the server only hands out static files and stores your documents.

| | App | Engine | Opens |
|---|---|---|---|
| `/docs` | **Docs**, a word processor | [WordCraft](https://github.com/storytold/wordcraft) | `.docx` `.doc` `.odt` `.rtf` `.md` `.txt` `.html` `.tex` |
| `/sheets` | **Sheets**, a spreadsheet | [GridCraft](https://github.com/storytold/gridcraft) | `.xlsx` `.xlsm` `.xlsb` `.ods` `.csv` `.tsv` |
| `/slides` | **Slides**, presentations | [DeckCraft](https://github.com/storytold/deckcraft) | `.pptx` `.ppsx` |

Put it on `office.domain.au` and the apps live at `office.domain.au/docs`, `/sheets` and `/slides`.
More apps can be added later (see [Adding an app](#adding-an-app)).

## Quick start

```yaml
# docker-compose.yml
services:
  office:
    build: .
    container_name: office
    restart: unless-stopped
    ports:
      - "9235:9235"
    volumes:
      # Everything you save lives here. Use a named volume (below) or a bind mount
      # such as ./data:/data (then run: sudo chown 65532:65532 ./data).
      - office-data:/data
    environment:
      OFFICE_MAX_UPLOAD_MB: "512"
      # Only needed if your reverse proxy rewrites the Host header:
      # OFFICE_ALLOWED_ORIGINS: "https://office.domain.au"
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true

volumes:
  office-data:
```

```sh
docker compose up -d --build
# open http://localhost:9235
```

The same file is in this repo as `docker-compose.yml`. To keep documents in a folder you can see on the host
instead of a named volume, use `- ./data:/data` and make it writable for the container's user first:

```sh
mkdir -p data && sudo chown 65532:65532 data
```

## How files are saved

The upstream apps are static WebAssembly apps that only know how to *download* and *upload* files through the
browser. Office adds a thin layer so a Docker volume works as real storage:

- **Save / Save As** in any app opens a **Save to Office** dialog. The file is written to `/data` on the server
  (atomically, so a crash never leaves a half-written document). *Download instead* is always one click away.
- **Open** in any app shows an **Open from Office** dialog listing the files on the server, with
  *Browse this computer…* for anything else.
- The home page has a **Your files** manager: upload by drag and drop, search, sort, rename, delete, download,
  and open a file straight in the right app (`/docs/?open=report.docx`).
- Hover the thin coloured tab on the left edge of any app to jump between Docs, Sheets, Slides and the home page.

Files are stored flat in `/data` as ordinary files (`/data/report.docx`), so you can back them up, sync them
or edit them from the host with any tool. There are no subfolders and no database.

Local, per-browser things stay in the browser: app preferences and the apps' own crash-recovery data are kept
in that browser's `localStorage`/IndexedDB.

## Reverse proxy and HTTPS

Run Office behind your usual proxy and give it its own hostname. HTTPS is strongly recommended: WebGPU and
the clipboard only work in a secure context (the apps fall back to WebGL2 on plain HTTP).

**Caddy**

```
office.domain.au {
    reverse_proxy office:9235
}
```

**nginx**

```nginx
server {
    server_name office.domain.au;
    client_max_body_size 512m;               # match OFFICE_MAX_UPLOAD_MB

    location / {
        proxy_pass http://127.0.0.1:9235;
        proxy_set_header Host $host;          # keep the original Host (see OFFICE_ALLOWED_ORIGINS)
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
    }
}
```

The server already sends Brotli/gzip-precompressed WebAssembly (the biggest app drops from 42 MB to about 9 MB
on the wire) and long-lived cache headers for the hashed app files, so the proxy does not need to compress.

## Security: read this before exposing it

**Office has no login.** Anyone who can reach it can read, replace and delete every file in the store.

- Run it on a trusted network, or put authentication in front of it (your proxy's basic auth, Authelia,
  Authentik, Cloudflare Access, a VPN, ...).
- Writes (`PUT`, `PATCH`, `DELETE`) from a browser must come from the same origin, so another website cannot
  use a visitor's browser to write into your store. If your proxy rewrites the `Host` header, either pass the
  original `Host` through (recommended) or list your public origin in `OFFICE_ALLOWED_ORIGINS`.
- Stored files are never rendered by the server; downloads are always sent as `attachment`.
- The container runs as an unprivileged user on Google's distroless `static-debian13` image (no shell, no
  package manager), with a read-only root filesystem in the example above.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `OFFICE_ADDR` | `:9235` | Listen address inside the container |
| `OFFICE_DATA_DIR` | `/data` | Where files are stored (mount your volume here) |
| `OFFICE_MAX_UPLOAD_MB` | `512` | Largest single file the server accepts |
| `OFFICE_ALLOWED_ORIGINS` | *(empty)* | Extra comma-separated origins allowed to write, e.g. `https://office.domain.au` |
| `OFFICE_APPS_DIR`, `OFFICE_APPS_JSON` | `/app/apps`, `/app/apps.json` | App location; leave alone for the stock image |

`GET /healthz` returns `ok`; the image's `HEALTHCHECK` uses `/app/office healthcheck`.

## Known limitations

- **Slides is pinned to DeckCraft 0.7.0.** The latest release (0.8.0) has a web-build bug that panics at
  startup and never loads ([storytold/deckcraft#959](https://github.com/storytold/deckcraft/issues/959),
  fixes proposed upstream but not yet released). The pin and its exit condition are recorded in
  `scripts/pins.conf`; once a fixed release ships, run `scripts/update-apps.sh slides` after removing the pin.
- Docs and Sheets are the latest releases (WordCraft 0.8.0, GridCraft 0.8.0).
- Save always asks for a file name (the upstream apps do not keep a persistent file handle, so Ctrl+S cannot
  silently overwrite). Press Enter to confirm: the dialog is pre-filled with the current name.
- Saving relies on how the upstream apps call the browser's file APIs today. See `AGENTS.md` for how that is
  re-verified after every app update.
- The file store is flat (no folders) and single-user (no per-user permissions or locking; last save wins).
- These are young projects. Expect rough edges and check that your documents round-trip before relying on them.

## Updating the apps

```sh
scripts/update-apps.sh            # all apps, or: scripts/update-apps.sh docs
```

This downloads each app's latest GitHub release web build, verifies it against the release's `SHA256SUMS.txt`,
replaces `Docs/`, `Sheets/` or `Slides/`, and records the source in each directory's `.upstream` file. Apps in
`scripts/pins.conf` stay on their pinned release. Afterwards follow the checklist in
[`AGENTS.md`](AGENTS.md#upgrading-the-bundled-apps-do-this-after-every-update-of-an-underlying-app) (re-test
open and save in every app) and rebuild the image.

## Adding an app

1. Put its static web build in a new directory next to `Docs/`, with an `index.html`.
2. Add an entry to `apps.json` (`slug`, `dir`, `name`, `tagline`, `accent`, `extensions`).
3. Add a `COPY` and `RUN precompress` pair for it to the `Dockerfile`.

The home page card, the URL (`/<slug>`), the file association and the Save/Open dialogs are picked up
automatically. Details are in `AGENTS.md`.

## Development

```sh
cd server && go test ./...

# Run locally against this checkout (no Docker):
OFFICE_ADDR=127.0.0.1:9235 OFFICE_DATA_DIR=/tmp/office-data \
OFFICE_APPS_DIR=.. OFFICE_APPS_JSON=../apps.json go run .

docker build -t office:dev .
```

The server is plain Go (standard library only) in `server/`. The home page and the Save/Open shim are embedded
in the binary from `server/web/`.

## Licence and credits

Docs, Sheets and Slides are the work of the [ArtCraft](https://getartcraft.com/) team and are redistributed here
unmodified under their own licences (Apache-2.0 or MIT; see the `LICENSE-*` files in each app directory, also
served at `/<slug>/LICENSE-APACHE`).

The Office server, home page and shim in this repository do not have a licence file yet. Add one that suits you
before publishing (Apache-2.0 would match the apps).
