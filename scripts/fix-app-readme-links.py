#!/usr/bin/env python3
"""Point an app README's relative links at the upstream repository.

The bundled READMEs are written for the upstream repo root, so links such as
`docs/images/hero.png` or `AGENTS.md` are dead here. This rewrites them to absolute
GitHub URLs pinned to the release tag that is bundled, using the tag's file tree to
choose between raw (images), blob (files) and tree (folders) URLs.

Only README.md is touched (it is neither served nor shipped in the image), and the
script is idempotent. update-apps.sh runs it after every refresh.

Usage: fix-app-readme-links.py <app dir> <owner/repo> <tag>      (needs the gh CLI)
"""
import json
import posixpath
import re
import subprocess
import sys
from pathlib import Path

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}


def load_tree(repo: str, tag: str) -> dict[str, str]:
    out = subprocess.run(
        ["gh", "api", f"repos/{repo}/git/trees/{tag}?recursive=1"],
        check=True, capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    if data.get("truncated"):
        sys.exit("file tree was truncated; cannot classify links reliably")
    return {e["path"]: e["type"] for e in data["tree"]}


def main() -> None:
    app_dir, repo, tag = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    readme = app_dir / "README.md"
    tree = load_tree(repo, tag)
    missing: set[str] = set()
    changed = 0

    def convert(target: str) -> str:
        nonlocal changed
        if re.match(r"([a-z][a-z0-9+.-]*:|#|/|//)", target, re.I) or not target:
            return target
        path_part, sep, tail = target.partition("#")
        path_part, qsep, query = path_part.partition("?")
        path = posixpath.normpath(path_part) if path_part else ""
        if not path or path.startswith(".."):
            return target
        if (app_dir / path).is_file():  # e.g. LICENSE-APACHE ships alongside the README
            return target
        kind = tree.get(path)
        if kind is None:
            missing.add(path)
            ref, kind = "main", ("tree" if path_part.endswith("/") else "blob")
        else:
            ref, kind = tag, ("tree" if kind == "tree" else "blob")
        if kind == "blob" and posixpath.splitext(path)[1].lower() in IMAGE_EXTS:
            url = f"https://raw.githubusercontent.com/{repo}/{ref}/{path}"
        else:
            url = f"https://github.com/{repo}/{kind}/{ref}/{path}"
        changed += 1
        return url + (qsep + query if qsep else "") + (sep + tail if sep else "")

    md_link = re.compile(r"(\]\()([^)\s]+)")                    # [text](target) and ![alt](target)
    md_ref = re.compile(r"^(\[[^\]]+\]:\s*)(\S+)", re.M)          # [label]: target
    html_attr = re.compile(r'((?:src|href)=")([^"]+)(")')         # <img src="..."> <a href="...">

    out, fenced = [], False
    for line in readme.read_text().splitlines(keepends=True):
        if line.lstrip().startswith("```"):
            fenced = not fenced
        elif not fenced:
            line = md_link.sub(lambda m: m.group(1) + convert(m.group(2)), line)
            line = md_ref.sub(lambda m: m.group(1) + convert(m.group(2)), line)
            line = html_attr.sub(lambda m: m.group(1) + convert(m.group(2)) + m.group(3), line)
        out.append(line)
    readme.write_text("".join(out))

    print(f"{readme}: rewrote {changed} link(s) to {repo}@{tag}")
    for path in sorted(missing):
        print(f"  warning: {path} not found at {tag}; linked to main instead", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main()
