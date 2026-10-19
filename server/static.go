package main

import (
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// contentTypes is the allowlist of file types served from an app directory.
// Anything else (README.md, _headers, .htaccess, ...) is a 404.
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".wasm":  "application/wasm",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".ico":   "image/x-icon",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".svg":   "image/svg+xml",
	".webp":  "image/webp",
	".woff2": "font/woff2",
	".txt":   "text/plain; charset=utf-8",
}

// handler serves one app's static build. Upstream files are served byte for
// byte (their index.html pins js/wasm with SRI hashes); only index.html is
// rewritten, in memory, to add the shim.
func (a *app) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := path.Clean("/" + r.URL.Path)[1:]
		if rel == "" || rel == "index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			w.Write(a.index)
			return
		}
		ctype, ok := servable(rel)
		if !ok {
			http.NotFound(w, r)
			return
		}

		w.Header().Add("Vary", "Accept-Encoding")
		name, encoding := rel, ""
		for _, enc := range []struct{ token, ext string }{{"br", ".br"}, {"gzip", ".gz"}} {
			if acceptsEncoding(r.Header.Get("Accept-Encoding"), enc.token) {
				if st, err := a.root.Stat(rel + enc.ext); err == nil && st.Mode().IsRegular() {
					name, encoding = rel+enc.ext, enc.token
					break
				}
			}
		}
		f, err := a.root.Open(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || !st.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}

		h := w.Header()
		h.Set("Content-Type", ctype)
		if encoding != "" {
			h.Set("Content-Encoding", encoding)
		}
		// Upstream names carry a content hash, so they are safe to cache forever.
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
		http.ServeContent(w, r, "", st.ModTime(), f)
	})
}

// servable reports whether rel may be served and with which Content-Type.
func servable(rel string) (string, bool) {
	if !fs.ValidPath(rel) {
		return "", false
	}
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") || strings.HasPrefix(seg, "_") {
			return "", false
		}
	}
	base := path.Base(rel)
	if strings.HasPrefix(base, "LICENSE") {
		return "text/plain; charset=utf-8", true
	}
	ext := strings.ToLower(path.Ext(base))
	ct, ok := contentTypes[ext]
	return ct, ok
}

// acceptsEncoding reports whether an Accept-Encoding header allows token.
func acceptsEncoding(header, token string) bool {
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(name), token) {
			p := strings.ReplaceAll(strings.ToLower(params), " ", "")
			if q, ok := strings.CutPrefix(p, "q="); ok {
				v, err := strconv.ParseFloat(q, 64)
				return err == nil && v > 0
			}
			return true
		}
	}
	return false
}
