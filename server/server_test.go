package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestServer builds a server over a temp apps tree with one app ("docs").
func newTestServer(t *testing.T) (*httptest.Server, config) {
	t.Helper()
	tmp := t.TempDir()
	appDir := filepath.Join(tmp, "apps", "Docs")
	must(t, os.MkdirAll(appDir, 0o755))
	must(t, os.WriteFile(filepath.Join(appDir, "index.html"), []byte("<!DOCTYPE html>\n<html><head>\n<title>x</title></head><body></body></html>"), 0o644))
	must(t, os.WriteFile(filepath.Join(appDir, "app_bg.wasm"), []byte("RAW-WASM"), 0o644))
	must(t, os.WriteFile(filepath.Join(appDir, "app_bg.wasm.br"), []byte("BR-WASM"), 0o644))
	must(t, os.WriteFile(filepath.Join(appDir, "app_bg.wasm.gz"), []byte("GZ-WASM"), 0o644))
	must(t, os.WriteFile(filepath.Join(appDir, "README.md"), []byte("secret notes"), 0o644))
	must(t, os.WriteFile(filepath.Join(appDir, "_headers"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(appDir, "LICENSE-MIT"), []byte("MIT"), 0o644))
	must(t, os.WriteFile(filepath.Join(tmp, "secret.txt"), []byte("outside"), 0o644))
	must(t, os.WriteFile(filepath.Join(tmp, "apps.json"), []byte(`{"apps":[{"slug":"docs","dir":"Docs","name":"Docs","accent":"#123456","extensions":["docx",".ODT"]}]}`), 0o644))

	cfg := config{
		addr:      ":0",
		dataDir:   filepath.Join(tmp, "data"),
		appsDir:   filepath.Join(tmp, "apps"),
		appsJSON:  filepath.Join(tmp, "apps.json"),
		maxUpload: 1 << 10, // 1 KiB keeps the size-limit test cheap
	}
	srv, err := newServer(cfg)
	must(t, err)
	ts := httptest.NewServer(srv.handler())
	t.Cleanup(ts.Close)
	return ts, cfg
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// do sends a request without following redirects or transparently decompressing.
func do(t *testing.T, method, url string, body io.Reader, hdr map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	must(t, err)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{DisableCompression: true},
	}
	resp, err := client.Do(req)
	must(t, err)
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	must(t, err)
	return resp, data
}

// isCleanRedirect matches ServeMux redirecting a path containing "." or ".." elements.
func isCleanRedirect(resp *http.Response) bool {
	return resp.StatusCode == 301 || resp.StatusCode == 307 || resp.StatusCode == 308
}

func TestHomeAndHealth(t *testing.T) {
	ts, _ := newTestServer(t)
	if resp, body := do(t, "GET", ts.URL+"/healthz", nil, nil); resp.StatusCode != 200 || !strings.Contains(string(body), "ok") {
		t.Fatalf("healthz: %d %q", resp.StatusCode, body)
	}
	resp, body := do(t, "GET", ts.URL+"/", nil, nil)
	if resp.StatusCode != 200 || !strings.Contains(string(body), "<title>Office</title>") {
		t.Fatalf("home: %d", resp.StatusCode)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Error("missing nosniff")
	}
	if resp, _ := do(t, "GET", ts.URL+"/nope", nil, nil); resp.StatusCode != 404 {
		t.Errorf("unknown path: %d", resp.StatusCode)
	}
}

func TestAppRedirectKeepsQuery(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, _ := do(t, "GET", ts.URL+"/docs?open=a%20b.docx", nil, nil)
	if resp.StatusCode != 308 || resp.Header.Get("Location") != "docs/?open=a%20b.docx" {
		t.Fatalf("redirect: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
}

func TestAppIndexGetsShim(t *testing.T) {
	ts, _ := newTestServer(t)
	resp, body := do(t, "GET", ts.URL+"/docs/", nil, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if !bytes.Contains(body, []byte(`<script src="../_office/shim.js" data-app="docs" data-accent="#123456"></script>`)) {
		t.Errorf("shim not injected: %s", body)
	}
	if !strings.HasPrefix(string(body), "<!DOCTYPE html>\n<html><head>") {
		t.Errorf("shim must go inside <head>: %s", body)
	}
	if resp.Header.Get("Cache-Control") != "no-cache" {
		t.Errorf("index cache-control: %q", resp.Header.Get("Cache-Control"))
	}
	if _, body := do(t, "GET", ts.URL+"/_office/shim.js", nil, nil); !bytes.Contains(body, []byte("showSaveFilePicker")) {
		t.Error("shim.js not served")
	}
}

func TestStaticAllowlistAndEncoding(t *testing.T) {
	ts, _ := newTestServer(t)
	for _, p := range []string{"/docs/README.md", "/docs/_headers", "/docs/app_bg.wasm.br", "/docs/../secret.txt", "/docs/%2e%2e/secret.txt", "/docs/nothing.js"} {
		resp, body := do(t, "GET", ts.URL+p, nil, nil)
		if resp.StatusCode != 404 && !isCleanRedirect(resp) {
			t.Errorf("%s: want 404 or a path-cleaning redirect, got %d", p, resp.StatusCode)
		}
		if bytes.Contains(body, []byte("outside")) || bytes.Contains(body, []byte("secret notes")) {
			t.Errorf("%s leaked a file", p)
		}
		// Following the cleaning redirect must not reach anything either.
		if isCleanRedirect(resp) {
			if next, _ := do(t, "GET", ts.URL+resp.Header.Get("Location"), nil, nil); next.StatusCode != 404 {
				t.Errorf("%s -> %s: got %d", p, resp.Header.Get("Location"), next.StatusCode)
			}
		}
	}
	if resp, body := do(t, "GET", ts.URL+"/docs/LICENSE-MIT", nil, nil); resp.StatusCode != 200 || string(body) != "MIT" {
		t.Errorf("license: %d", resp.StatusCode)
	}

	cases := []struct{ accept, wantBody, wantEnc string }{
		{"gzip, br", "BR-WASM", "br"},
		{"gzip", "GZ-WASM", "gzip"},
		{"br;q=0, gzip", "GZ-WASM", "gzip"},
		{"", "RAW-WASM", ""},
		{"identity", "RAW-WASM", ""},
	}
	for _, c := range cases {
		resp, body := do(t, "GET", ts.URL+"/docs/app_bg.wasm", nil, map[string]string{"Accept-Encoding": c.accept})
		if string(body) != c.wantBody || resp.Header.Get("Content-Encoding") != c.wantEnc {
			t.Errorf("Accept-Encoding %q: got %q/%q", c.accept, body, resp.Header.Get("Content-Encoding"))
		}
		if resp.Header.Get("Content-Type") != "application/wasm" {
			t.Errorf("wasm content type: %q", resp.Header.Get("Content-Type"))
		}
		if !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
			t.Errorf("wasm cache-control: %q", resp.Header.Get("Cache-Control"))
		}
	}
}

func TestFileStoreLifecycle(t *testing.T) {
	ts, cfg := newTestServer(t)
	put := func(name, body string, hdr map[string]string) (*http.Response, []byte) {
		return do(t, "PUT", ts.URL+"/api/files/"+name, strings.NewReader(body), hdr)
	}

	resp, body := put("report.docx", "v1", nil)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, body)
	}
	var created fileInfo
	must(t, json.Unmarshal(body, &created))
	if created.Name != "report.docx" || created.Size != 2 || created.App != "docs" {
		t.Errorf("created: %+v", created)
	}
	if resp, _ := put("report.docx", "version two", nil); resp.StatusCode != 200 {
		t.Errorf("overwrite: %d", resp.StatusCode)
	}
	if resp, _ := put("report.docx", "x", map[string]string{"If-None-Match": "*"}); resp.StatusCode != 412 {
		t.Errorf("create-only on existing: %d", resp.StatusCode)
	}
	if got, _ := os.ReadFile(filepath.Join(cfg.dataDir, "report.docx")); string(got) != "version two" {
		t.Errorf("on disk: %q", got)
	}

	// Download is forced to an attachment so user files are never rendered.
	resp, body = do(t, "GET", ts.URL+"/api/files/report.docx", nil, nil)
	if string(body) != "version two" || resp.Header.Get("Content-Type") != "application/octet-stream" ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment") {
		t.Errorf("download: %q %v", body, resp.Header)
	}

	// Listing ignores temp/hidden files and extensions are matched case-insensitively.
	must(t, os.WriteFile(filepath.Join(cfg.dataDir, ".upload-123"), []byte("partial"), 0o644))
	put("notes.ODT", "n", nil)
	put("misc.bin", "m", nil)
	_, body = do(t, "GET", ts.URL+"/api/files", nil, nil)
	var list struct{ Files []fileInfo }
	must(t, json.Unmarshal(body, &list))
	apps := map[string]string{}
	for _, f := range list.Files {
		apps[f.Name] = f.App
	}
	if len(apps) != 3 || apps["report.docx"] != "docs" || apps["notes.ODT"] != "docs" || apps["misc.bin"] != "" {
		t.Errorf("list: %v", apps)
	}

	// Rename, including conflicts.
	rename := func(from, to string) int {
		resp, _ := do(t, "PATCH", ts.URL+"/api/files/"+from, strings.NewReader(`{"name":"`+to+`"}`), nil)
		return resp.StatusCode
	}
	if c := rename("misc.bin", "report.docx"); c != 409 {
		t.Errorf("rename onto existing: %d", c)
	}
	if c := rename("misc.bin", "renamed.bin"); c != 200 {
		t.Errorf("rename: %d", c)
	}
	if c := rename("ghost.bin", "x.bin"); c != 404 {
		t.Errorf("rename missing: %d", c)
	}

	if resp, _ := do(t, "DELETE", ts.URL+"/api/files/renamed.bin", nil, nil); resp.StatusCode != 204 {
		t.Errorf("delete: %d", resp.StatusCode)
	}
	if resp, _ := do(t, "DELETE", ts.URL+"/api/files/renamed.bin", nil, nil); resp.StatusCode != 404 {
		t.Errorf("delete again: %d", resp.StatusCode)
	}
	// No leftovers from the atomic write path (the manually planted file stays).
	entries, _ := os.ReadDir(cfg.dataDir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".upload-") && e.Name() != ".upload-123" {
			t.Errorf("leftover temp file %s", e.Name())
		}
	}
}

func TestFileStoreRejectsBadInput(t *testing.T) {
	ts, cfg := newTestServer(t)
	for _, name := range []string{"..", ".hidden", "a%2Fb.docx", "a%5Cb.docx", "bad%3Aname.docx", "trailing.", "%20lead.docx", strings.Repeat("a", 201)} {
		if resp, _ := do(t, "PUT", ts.URL+"/api/files/"+name, strings.NewReader("x"), nil); resp.StatusCode != 400 && !isCleanRedirect(resp) {
			t.Errorf("PUT %q: want rejection, got %d", name, resp.StatusCode)
		}
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(cfg.dataDir), "b.docx")); err == nil {
		t.Error("path traversal wrote outside the data dir")
	}

	// maxUpload is 1 KiB: known and streamed lengths are both refused.
	big := strings.Repeat("x", 2048)
	if resp, _ := do(t, "PUT", ts.URL+"/api/files/big.bin", strings.NewReader(big), nil); resp.StatusCode != 413 {
		t.Errorf("oversized: %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("PUT", ts.URL+"/api/files/big2.bin", io.NopCloser(strings.NewReader(big))) // unknown length
	resp, err := http.DefaultClient.Do(req)
	must(t, err)
	resp.Body.Close()
	if resp.StatusCode != 413 {
		t.Errorf("oversized chunked: %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(cfg.dataDir, "big2.bin")); err == nil {
		t.Error("oversized upload was kept")
	}
}

func TestCrossOriginWritesRefused(t *testing.T) {
	ts, _ := newTestServer(t)
	host := strings.TrimPrefix(ts.URL, "http://")
	cases := []struct {
		name string
		hdr  map[string]string
		want int
	}{
		{"no origin (curl)", nil, 201},
		{"same origin", map[string]string{"Origin": "http://" + host}, 200},
		{"evil origin", map[string]string{"Origin": "https://evil.example"}, 403},
		{"null origin", map[string]string{"Origin": "null"}, 403},
		{"cross-site fetch metadata", map[string]string{"Sec-Fetch-Site": "cross-site"}, 403},
		{"proxy host", map[string]string{"Origin": "https://office.domain.au", "X-Forwarded-Host": "office.domain.au"}, 200},
	}
	for _, c := range cases {
		resp, _ := do(t, "PUT", ts.URL+"/api/files/x.docx", strings.NewReader("x"), c.hdr)
		if resp.StatusCode != c.want {
			t.Errorf("%s: got %d want %d", c.name, resp.StatusCode, c.want)
		}
	}
	// Reads stay open to any origin; they are simple GETs that return no secrets cross-site.
	if resp, _ := do(t, "DELETE", ts.URL+"/api/files/x.docx", nil, map[string]string{"Origin": "https://evil.example"}); resp.StatusCode != 403 {
		t.Errorf("cross-origin delete: %d", resp.StatusCode)
	}
}

func TestAllowedOriginsEnv(t *testing.T) {
	ts, cfg := newTestServer(t)
	_ = ts
	cfg.allowedOrigins = []string{"https://office.domain.au"}
	srv, err := newServer(cfg)
	must(t, err)
	ts2 := httptest.NewServer(srv.handler())
	defer ts2.Close()
	resp, _ := do(t, "PUT", ts2.URL+"/api/files/y.docx", strings.NewReader("y"), map[string]string{"Origin": "https://office.domain.au"})
	if resp.StatusCode != 201 {
		t.Errorf("allowed origin: %d", resp.StatusCode)
	}
}

func TestValidName(t *testing.T) {
	good := []string{"a.docx", "My report (final).docx", "café.xlsx", "日本語.pptx", "a b.txt"}
	bad := []string{"", ".", "..", ".env", "a/b", `a\b`, "a:b", "a*b", "a?b", `a"b`, "a<b", "a>b", "a|b", "x\x00y", "x\ny", " lead", "trail ", "dot.", "\xff.docx"}
	for _, n := range good {
		if !validName(n) {
			t.Errorf("validName(%q) = false", n)
		}
	}
	for _, n := range bad {
		if validName(n) {
			t.Errorf("validName(%q) = true", n)
		}
	}
}

func TestAcceptsEncoding(t *testing.T) {
	cases := []struct {
		header, token string
		want          bool
	}{
		{"gzip, deflate, br", "br", true},
		{"gzip", "br", false},
		{"br;q=0", "br", false},
		{"br; q=0.0", "br", false},
		{"br;q=0.5", "br", true},
		{"BR", "br", true},
		{"", "gzip", false},
	}
	for _, c := range cases {
		if got := acceptsEncoding(c.header, c.token); got != c.want {
			t.Errorf("acceptsEncoding(%q,%q)=%v", c.header, c.token, got)
		}
	}
}
