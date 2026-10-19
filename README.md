# Office

A self-hosted, open-source office suite in one small Docker container: **Docs**, **Sheets** and **Slides**,
with a fast, animated home page and a shared file store on a volume you control. Everything runs in the
browser; the server only hands out static files and stores your documents.

| | App | Engine | Opens |
|---|---|---|---|
| `/docs` | **Docs**, a word processor | [WordCraft](https://github.com/storytold/wordcraft) | `.docx` `.doc` `.odt` `.rtf` `.md` `.txt` `.html` `.tex` |
| `/sheets` | **Sheets**, a spreadsheet | [GridCraft](https://github.com/storytold/gridcraft) | `.xlsx` `.xlsm` `.xlsb` `.ods` `.csv` `.tsv` |
| `/slides` | **Slides**, presentations | [DeckCraft](https://github.com/storytold/deckcraft) | `.pptx` `.ppsx` |

Give it its own hostname, for example `office.buzzy.au`, and the apps live at `office.buzzy.au/docs`, `office.buzzy.au/sheets` and `office.buzzy.au/slides`.
More apps can be added later (see [Adding an app](#adding-an-app)).

## Quick start

```yaml
# docker-compose.yml
services:
  office:
    image: ghcr.io/buzzmoody/office:latest
    # To build from this checkout instead of pulling the image:
    # build: .
    container_name: office
    restart: unless-stopped
    ports:
      - "9235:9235"          # not needed if your reverse proxy joins the "office" network
    volumes:
      # Everything you save lives here (owned by the container user, uid 65532).
      - /Storage/Docker/office:/data
    environment:
      OFFICE_MAX_UPLOAD_MB: "512"
      OFFICE_ALLOWED_ORIGINS: "https://office.buzzy.au"
    networks:
      - office
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true

networks:
  office:
    name: office
    driver: bridge
    enable_ipv6: true
```

```sh
sudo mkdir -p /Storage/Docker/office && sudo chown 65532:65532 /Storage/Docker/office
docker compose up -d
# open http://localhost:9235
```

- **Volume:** `/Storage/Docker/office` on the host is mounted at `/data` in the container. The container runs as
  an unprivileged user (uid 65532), so that folder must be writable by it (the `chown` above). Files you save
  appear there as ordinary files owned by uid 65532, so back them up or sync them like any other folder.
- **Network:** the container joins its own IPv6-enabled bridge network called `office`. Docker 28 and later
  assigns the IPv6 subnet automatically; on older Docker add an `ipam` block with an IPv6 `subnet` to the network.
  Other containers (your reverse proxy) can join it with `networks: { office: { external: true } }`.
- **Image:** `ghcr.io/buzzmoody/office` is built by the *Publish Docker image* workflow. While the repository or
  package is private, run `docker login ghcr.io` first (a token with `read:packages`).
- The same file is in this repo as `docker-compose.yml`.

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

Run Office behind your usual proxy on its own hostname (the examples use `office.buzzy.au`). HTTPS is strongly
recommended: WebGPU and the clipboard only work in a secure context (the apps fall back to WebGL2 on plain HTTP).

Each proxy needs to reach the container. The easiest way is to put the proxy on the `office` network from the
compose file above and forward to `office:9235`; otherwise forward to `<docker host>:9235`. In every case the
proxy must pass the original `Host` header through (all four below do by default), or saves are refused unless
the public origin is listed in `OFFICE_ALLOWED_ORIGINS`. Uploads can be large, so make sure the proxy does not cap
request bodies below `OFFICE_MAX_UPLOAD_MB`.

The server already sends Brotli/gzip-precompressed WebAssembly (the biggest app drops from 42 MB to about 9 MB
on the wire) and long-lived cache headers for the hashed app files, so the proxy does not need to compress.

### Caddy

`Caddyfile`:

```
office.buzzy.au {
    reverse_proxy office:9235
}
```

```yaml
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data        # certificates
      - caddy-config:/config
    networks:
      - office

volumes:
  caddy-data:
  caddy-config:

networks:
  office:
    external: true
```

Caddy gets and renews the certificate for `office.buzzy.au` by itself and sets no request size limit.

### Nginx Proxy Manager

Attach the Nginx Proxy Manager container to the `office` network (add `networks: [office]` with
`office: { external: true }` to its compose file, or run `docker network connect office <npm container>`), then in
the web UI:

1. **Hosts → Proxy Hosts → Add Proxy Host**
   - **Domain Names:** `office.buzzy.au`
   - **Scheme:** `http`, **Forward Hostname / IP:** `office`, **Forward Port:** `9235`
   - Turn on **Block Common Exploits**. Websockets are not needed.
2. **SSL** tab: choose *Request a new SSL Certificate*, then turn on **Force SSL** and **HTTP/2 Support**.
3. **Advanced** tab, **Custom Nginx Configuration** (nginx limits request bodies to 1 MB by default, which would
   break saving and uploading real documents):

   ```nginx
   client_max_body_size 512m;    # match OFFICE_MAX_UPLOAD_MB
   proxy_request_buffering off;
   ```

If Nginx Proxy Manager is not on the `office` network, set **Forward Hostname / IP** to your Docker host's address
instead (the compose file publishes port 9235).

### Ferron 2

Ferron 2 is configured in a KDL-style `ferron.kdl`. It keeps the original `Host` header for plain-HTTP backends and
adds `X-Forwarded-Host`.

`ferron.kdl`:

```
office.buzzy.au {
    proxy "http://office:9235/"
}
```

```yaml
services:
  ferron:
    image: ferronserver/ferron:2
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./ferron.kdl:/etc/ferron.kdl
      - ferron-acme:/var/cache/ferron-acme    # keeps automatic TLS certificates across restarts
    networks:
      - office

volumes:
  ferron-acme:

networks:
  office:
    external: true
```

### Ferron 3

Ferron 3 reads `.conf` files from a `conf.d` directory (its docs mark version 3 as a release candidate at the time
of writing). It preserves the incoming `Host` header by default, so no override is needed.

`ferron-conf.d/ferron.conf`:

```
office.buzzy.au {
    proxy http://office:9235
}
```

```yaml
services:
  ferron:
    image: ferronserver/ferron:3
    restart: always
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"                         # HTTP/3
    volumes:
      - ./ferron-conf.d:/etc/ferron/conf.d
      - ferron-acme:/var/cache/ferron-acme    # keeps automatic TLS certificates across restarts
    networks:
      - office

volumes:
  ferron-acme:

networks:
  office:
    external: true
```

Both Ferron versions obtain certificates automatically for public domain names (see the Ferron docs for the
challenge types). If large uploads are rejected, check Ferron's documentation for a request body size limit.

## Security: read this before exposing it

**Office has no login.** Anyone who can reach it can read, replace and delete every file in the store.

- Run it on a trusted network, or put authentication in front of it (your proxy's basic auth, Authelia,
  Authentik, Cloudflare Access, a VPN, ...).
- Writes (`PUT`, `PATCH`, `DELETE`) from a browser must come from the same origin, so another website cannot
  use a visitor's browser to write into your store. If your proxy rewrites the `Host` header, either pass the
  original `Host` through (recommended) or list your public origin in `OFFICE_ALLOWED_ORIGINS`.
- Stored files are never rendered by the server; downloads are always sent as `attachment`.
- The container runs as an unprivileged user on Google's distroless `static-debian13` image (no shell, no
  package manager), with a read-only root filesystem in the compose example.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `OFFICE_ADDR` | `:9235` | Listen address inside the container |
| `OFFICE_DATA_DIR` | `/data` | Where files are stored (mount your volume here) |
| `OFFICE_MAX_UPLOAD_MB` | `512` | Largest single file the server accepts |
| `OFFICE_ALLOWED_ORIGINS` | *(empty)* | Extra comma-separated origins allowed to write, e.g. `https://office.buzzy.au` |
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
replaces `Docs/`, `Sheets/` or `Slides/`, points the app READMEs' relative links at their upstream repositories,
and records the source in each directory's `.upstream` file. Apps in
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

The Office server, home page, Save/Open shim, Docker and CI files in this repository are licensed under the
[Apache License 2.0](LICENSE).

Docs, Sheets and Slides are the work of the [ArtCraft](https://getartcraft.com/) team and are redistributed here
unmodified under their own licences (Apache-2.0 or MIT; see the `LICENSE-*` files in each app directory, also
served at `/<slug>/LICENSE-APACHE`). Their READMEs link back to the upstream repositories:
[WordCraft](https://github.com/storytold/wordcraft), [GridCraft](https://github.com/storytold/gridcraft) and
[DeckCraft](https://github.com/storytold/deckcraft).
