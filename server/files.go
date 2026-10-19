package main

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const maxNameBytes = 200

type fileInfo struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	App      string    `json:"app,omitempty"` // slug of the app that opens this file
}

func ensureDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	probe, err := os.CreateTemp(dir, ".write-test-*")
	if err != nil {
		return err
	}
	probe.Close()
	return os.Remove(probe.Name())
}

// validName accepts a plain file name: no path separators, no hidden files,
// no control characters.
func validName(name string) bool {
	if name == "" || len(name) > maxNameBytes || !utf8.ValidString(name) {
		return false
	}
	if name[0] == '.' || strings.TrimSpace(name) != name || strings.HasSuffix(name, ".") {
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' || r == ':' || r == '*' || r == '?' || r == '"' || r == '<' || r == '>' || r == '|' {
			return false
		}
	}
	return true
}

func (s *server) appFor(name string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if ext == "" {
		return ""
	}
	for _, a := range s.apps {
		for _, e := range a.Extensions {
			if e == ext {
				return a.Slug
			}
		}
	}
	return ""
}

func (s *server) handleInfo(w http.ResponseWriter, r *http.Request) {
	type appInfo struct {
		Slug       string   `json:"slug"`
		Name       string   `json:"name"`
		Engine     string   `json:"engine"`
		Repo       string   `json:"repo"`
		Tagline    string   `json:"tagline"`
		Accent     string   `json:"accent"`
		Extensions []string `json:"extensions"`
	}
	apps := make([]appInfo, 0, len(s.apps))
	for _, a := range s.apps {
		apps = append(apps, appInfo{a.Slug, a.Name, a.Engine, a.Repo, a.Tagline, a.Accent, a.Extensions})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version":        version,
		"apps":           apps,
		"maxUploadBytes": s.cfg.maxUpload,
	})
}

func (s *server) handleList(w http.ResponseWriter, r *http.Request) {
	entries, err := os.ReadDir(s.cfg.dataDir)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cannot read data directory")
		log.Printf("list: %v", err)
		return
	}
	files := make([]fileInfo, 0, len(entries))
	for _, e := range entries {
		if !e.Type().IsRegular() || !validName(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileInfo{e.Name(), info.Size(), info.ModTime().UTC(), s.appFor(e.Name())})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Modified.After(files[j].Modified) })
	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (s *server) handleGet(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validName(name) {
		httpError(w, http.StatusBadRequest, "invalid file name")
		return
	}
	f, err := os.Open(filepath.Join(s.cfg.dataDir, name))
	if err != nil {
		httpError(w, http.StatusNotFound, "no such file")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		httpError(w, http.StatusNotFound, "no such file")
		return
	}
	// Files are user content on the same origin as the apps: never let the
	// browser render them, only download them.
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	h.Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

func (s *server) handlePut(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(w, r) {
		return
	}
	name := r.PathValue("name")
	if !validName(name) {
		httpError(w, http.StatusBadRequest, "invalid file name")
		return
	}
	target := filepath.Join(s.cfg.dataDir, name)
	if r.Header.Get("If-None-Match") == "*" {
		if _, err := os.Lstat(target); err == nil {
			httpError(w, http.StatusPreconditionFailed, "file already exists")
			return
		}
	}
	if r.ContentLength > s.cfg.maxUpload {
		httpError(w, http.StatusRequestEntityTooLarge, "file too large")
		return
	}

	tmp, err := os.CreateTemp(s.cfg.dataDir, ".upload-*")
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cannot write file")
		log.Printf("put %q: %v", name, err)
		return
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename

	n, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, s.cfg.maxUpload))
	if err == nil {
		err = tmp.Sync()
	}
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpError(w, http.StatusRequestEntityTooLarge, "file too large")
		} else {
			httpError(w, http.StatusInternalServerError, "upload failed")
			log.Printf("put %q: %v", name, err)
		}
		return
	}
	_ = os.Chmod(tmp.Name(), 0o644)
	_, statErr := os.Lstat(target)
	if err := os.Rename(tmp.Name(), target); err != nil {
		httpError(w, http.StatusInternalServerError, "cannot write file")
		log.Printf("put %q: %v", name, err)
		return
	}
	status := http.StatusCreated
	if statErr == nil {
		status = http.StatusOK
	}
	writeJSON(w, status, fileInfo{name, n, time.Now().UTC(), s.appFor(name)})
}

func (s *server) handleRename(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(w, r) {
		return
	}
	name := r.PathValue("name")
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		httpError(w, http.StatusBadRequest, "expected {\"name\": \"new name\"}")
		return
	}
	if !validName(name) || !validName(body.Name) {
		httpError(w, http.StatusBadRequest, "invalid file name")
		return
	}
	from, to := filepath.Join(s.cfg.dataDir, name), filepath.Join(s.cfg.dataDir, body.Name)
	if _, err := os.Lstat(from); err != nil {
		httpError(w, http.StatusNotFound, "no such file")
		return
	}
	if _, err := os.Lstat(to); err == nil {
		httpError(w, http.StatusConflict, "a file with that name already exists")
		return
	}
	if err := os.Rename(from, to); err != nil {
		httpError(w, http.StatusInternalServerError, "cannot rename file")
		log.Printf("rename %q: %v", name, err)
		return
	}
	info, err := os.Stat(to)
	if err != nil {
		httpError(w, http.StatusInternalServerError, "cannot rename file")
		return
	}
	writeJSON(w, http.StatusOK, fileInfo{body.Name, info.Size(), info.ModTime().UTC(), s.appFor(body.Name)})
}

func (s *server) handleDelete(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(w, r) {
		return
	}
	name := r.PathValue("name")
	if !validName(name) {
		httpError(w, http.StatusBadRequest, "invalid file name")
		return
	}
	if err := os.Remove(filepath.Join(s.cfg.dataDir, name)); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			httpError(w, http.StatusNotFound, "no such file")
		} else {
			httpError(w, http.StatusInternalServerError, "cannot delete file")
			log.Printf("delete %q: %v", name, err)
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// sameOrigin blocks cross-site writes. Office has no login, so without this any
// web page the user visits could write into the file store through their browser.
// A browser request is accepted when its Origin matches the Host it was sent to
// (or X-Forwarded-Host behind a proxy), or is listed in OFFICE_ALLOWED_ORIGINS.
func (s *server) sameOrigin(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		httpError(w, http.StatusForbidden, "cross-site request refused")
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true // not a browser (curl, scripts)
	}
	if u, err := url.Parse(origin); err == nil && u.Host != "" {
		host := r.Host
		if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
			host, _, _ = strings.Cut(fwd, ",")
			host = strings.TrimSpace(host)
		}
		if strings.EqualFold(u.Host, host) {
			return true
		}
		for _, allowed := range s.cfg.allowedOrigins {
			if strings.EqualFold(origin, allowed) {
				return true
			}
		}
	}
	httpError(w, http.StatusForbidden, "cross-origin request refused (set OFFICE_ALLOWED_ORIGINS if you are behind a proxy that rewrites Host)")
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
