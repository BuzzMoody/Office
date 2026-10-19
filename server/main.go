// Command office serves the Office home page, the bundled web apps and a
// small file store backed by a single data directory.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

type config struct {
	addr      string
	dataDir   string
	appsDir   string
	appsJSON  string
	maxUpload int64
	// allowedOrigins are extra origins (https://office.example.com) allowed to
	// write files, for proxies that rewrite the Host header.
	allowedOrigins []string
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func loadConfig() (config, error) {
	c := config{
		addr:     envOr("OFFICE_ADDR", ":9235"),
		dataDir:  envOr("OFFICE_DATA_DIR", "/data"),
		appsDir:  envOr("OFFICE_APPS_DIR", "/app/apps"),
		appsJSON: envOr("OFFICE_APPS_JSON", "/app/apps.json"),
	}
	mb, err := strconv.ParseInt(envOr("OFFICE_MAX_UPLOAD_MB", "512"), 10, 64)
	if err != nil || mb <= 0 {
		return c, fmt.Errorf("OFFICE_MAX_UPLOAD_MB must be a positive integer")
	}
	c.maxUpload = mb << 20
	for _, o := range strings.Split(os.Getenv("OFFICE_ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			c.allowedOrigins = append(c.allowedOrigins, o)
		}
	}
	return c, nil
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("office: ")

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	srv, err := newServer(cfg)
	if err != nil {
		log.Fatal(err)
	}

	hs := &http.Server{
		Addr:              cfg.addr,
		Handler:           srv.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()

	names := make([]string, 0, len(srv.apps))
	for _, a := range srv.apps {
		names = append(names, "/"+a.Slug+"/")
	}
	log.Printf("v%s listening on %s, apps %s, data %s", version, cfg.addr, strings.Join(names, " "), cfg.dataDir)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// healthcheck lets a distroless image (no curl, no shell) report its own health.
func healthcheck() int {
	_, port, err := net.SplitHostPort(envOr("OFFICE_ADDR", ":9235"))
	if err != nil {
		port = "9235"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintln(os.Stderr, "unhealthy:", resp.Status)
		return 1
	}
	return 0
}

// app describes one web app listed in apps.json.
type app struct {
	Slug       string   `json:"slug"`
	Dir        string   `json:"dir"`
	Name       string   `json:"name"`
	Engine     string   `json:"engine"`
	Repo       string   `json:"repo"`
	Tagline    string   `json:"tagline"`
	Accent     string   `json:"accent"`
	Extensions []string `json:"extensions"`

	root  *os.Root // sandboxed view of the app directory
	index []byte   // index.html with the Office shim injected
}

func loadApps(cfg config) ([]*app, error) {
	raw, err := os.ReadFile(cfg.appsJSON)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", cfg.appsJSON, err)
	}
	var doc struct {
		Apps []*app `json:"apps"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", cfg.appsJSON, err)
	}
	seen := map[string]bool{}
	var out []*app
	for _, a := range doc.Apps {
		if a.Slug == "" || a.Dir == "" || strings.ContainsAny(a.Slug, "/\\.") || strings.ContainsAny(a.Dir, "/\\") || a.Dir[0] == '.' {
			return nil, fmt.Errorf("apps.json: invalid slug %q or dir %q", a.Slug, a.Dir)
		}
		if reservedSlugs[a.Slug] || seen[a.Slug] {
			return nil, fmt.Errorf("apps.json: slug %q is reserved or duplicated", a.Slug)
		}
		seen[a.Slug] = true
		root, err := os.OpenRoot(filepath.Join(cfg.appsDir, a.Dir))
		if err != nil {
			log.Printf("skipping app %q: %v", a.Slug, err)
			continue
		}
		page, err := readFile(root, "index.html")
		if err != nil {
			root.Close()
			log.Printf("skipping app %q: %v", a.Slug, err)
			continue
		}
		a.root = root
		a.index = injectShim(page, a)
		for i, e := range a.Extensions {
			a.Extensions[i] = strings.ToLower(strings.TrimPrefix(e, "."))
		}
		out = append(out, a)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no apps found under %s", cfg.appsDir)
	}
	return out, nil
}

var reservedSlugs = map[string]bool{"api": true, "healthz": true, "_office": true}

func readFile(root *os.Root, name string) ([]byte, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}
