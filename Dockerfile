# syntax=docker/dockerfile:1

# ---- 1. Build the Go server (static binary, stdlib only) --------------------
FROM --platform=$BUILDPLATFORM golang:1.27-trixie AS server
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/office .

# ---- 2. Stage the web apps and precompress them -----------------------------
# The apps are plain static files, so this stage is architecture independent.
FROM --platform=$BUILDPLATFORM debian:trixie-slim AS apps
RUN apt-get update \
 && apt-get install -y --no-install-recommends brotli gzip findutils \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/precompress.sh /usr/local/bin/precompress
COPY apps.json /out/apps.json
# One COPY + RUN per app, so updating one app only recompresses that app
# (a single COPY of several directories would also merge them into one).
# To add an app: add its directory here and an entry to apps.json.
COPY Docs   /out/apps/Docs
RUN precompress /out/apps/Docs
COPY Sheets /out/apps/Sheets
RUN precompress /out/apps/Sheets
COPY Slides /out/apps/Slides
RUN precompress /out/apps/Slides
RUN mkdir -p /out/data

# ---- 3. Runtime: Google's distroless static image on Debian 13 --------------
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=apps   /out/apps.json /app/apps.json
COPY --from=apps   /out/apps      /app/apps
COPY --from=server /out/office    /app/office
# Empty data dir owned by the nonroot user (65532) so a named volume is writable.
COPY --from=apps --chown=65532:65532 /out/data /data

ENV OFFICE_ADDR=:9235 \
    OFFICE_DATA_DIR=/data \
    OFFICE_APPS_DIR=/app/apps \
    OFFICE_APPS_JSON=/app/apps.json

VOLUME /data
EXPOSE 9235
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["/app/office", "healthcheck"]
ENTRYPOINT ["/app/office"]
