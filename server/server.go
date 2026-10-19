package main

import (
	"bytes"
	"embed"
	"fmt"
	"html"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"
)

//go:embed web
var webFS embed.FS

type server struct {
	cfg  config
	apps []*app
	web  fs.FS // embedded "web" directory
	home []byte
	nf   []byte
}

func newServer(cfg config) (*server, error) {
	apps, err := loadApps(cfg)
	if err != nil {
		return nil, err
	}
	store, err := fs.Sub(webFS, "web")
	if err != nil {
		return nil, err
	}
	s := &server{cfg: cfg, apps: apps, web: store}
	if s.home, err = fs.ReadFile(store, "home/index.html"); err != nil {
		return nil, err
	}
	if s.nf, err = fs.ReadFile(store, "home/404.html"); err != nil {
		return nil, err
	}
	if err := ensureDir(cfg.dataDir); err != nil {
		return nil, fmt.Errorf("data dir: %w", err)
	}
	return s, nil
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintln(w, "ok")
	})

	// Home page and its assets.
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(s.home)
	})
	mux.Handle("GET /_office/", http.StripPrefix("/_office/", s.officeAssets()))

	// File store API.
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("GET /api/files", s.handleList)
	mux.HandleFunc("GET /api/files/{name}", s.handleGet)
	mux.HandleFunc("HEAD /api/files/{name}", s.handleGet)
	mux.HandleFunc("PUT /api/files/{name}", s.handlePut)
	mux.HandleFunc("PATCH /api/files/{name}", s.handleRename)
	mux.HandleFunc("DELETE /api/files/{name}", s.handleDelete)

	// One subtree per app: /docs/, /sheets/, ...
	for _, a := range s.apps {
		mux.HandleFunc("GET /"+a.Slug, redirectToSlash(a.Slug))
		mux.Handle("GET /"+a.Slug+"/", http.StripPrefix("/"+a.Slug+"/", a.handler()))
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusNotFound)
		w.Write(s.nf)
	})

	return logRequests(securityHeaders(mux))
}

// redirectToSlash sends /docs to /docs/ with a relative Location so the redirect
// keeps working behind a reverse proxy that mounts Office under a prefix.
func redirectToSlash(slug string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		loc := slug + "/"
		if r.URL.RawQuery != "" {
			loc += "?" + r.URL.RawQuery
		}
		w.Header().Set("Location", loc)
		w.WriteHeader(http.StatusPermanentRedirect)
	}
}

// officeAssets serves the shim and home page assets embedded in the binary.
func (s *server) officeAssets() http.Handler {
	assets, _ := fs.Sub(s.web, "assets")
	fileServer := http.FileServerFS(assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})
}

// injectShim adds the Office shim script as the first thing in <head>, so it
// runs before the app's module script.
func injectShim(page []byte, a *app) []byte {
	tag := []byte(`<script src="../_office/shim.js" data-app="` + html.EscapeString(a.Slug) + `" data-accent="` + html.EscapeString(a.Accent) + `"></script>`)
	i := bytes.Index(bytes.ToLower(page), []byte("<head>"))
	if i < 0 {
		return append(tag, page...)
	}
	i += len("<head>")
	out := make([]byte, 0, len(page)+len(tag)+1)
	out = append(out, page[:i]...)
	out = append(out, '\n')
	out = append(out, tag...)
	out = append(out, page[i:]...)
	return out
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Content-Security-Policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'self'")
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		// Static assets are noisy; log them only when something went wrong.
		if strings.HasPrefix(r.URL.Path, "/api/") || rec.status >= 400 || r.URL.Path == "/" {
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
		}
	})
}
