#!/usr/bin/env python
"""Normalize text files to LF endings.

Python's ``json.dump``/``write_text`` on Windows opens in text mode, so every
rewrite of a repo file reintroduces CRLF and turns a small JSON edit into a
whole-file diff. Run this after any script that rewrites tracked files.
"""

from __future__ import annotations

import sys
from pathlib import Path

TEXT_SUFFIXES = {".json", ".py", ".ts", ".tsx", ".mjs", ".md", ".css"}


def normalize(path: Path) -> bool:
    raw = path.read_bytes()
    if b"\r\n" not in raw:
        return False
    path.write_bytes(raw.replace(b"\r\n", b"\n"))
    return True


def main(argv: list[str]) -> int:
    roots = [Path(arg) for arg in argv[1:]] or [Path.cwd()]
    changed = []
    for root in roots:
        targets = root.rglob("*") if root.is_dir() else [root]
        for path in targets:
            if not path.is_file() or path.suffix not in TEXT_SUFFIXES:
                continue
            if ".git" in path.parts or "node_modules" in path.parts:
                continue
            if normalize(path):
                changed.append(path)
    for path in changed:
        print(f"LF: {path}")
    print(f"{len(changed)} file(s) normalized to LF")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
