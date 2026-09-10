#!/usr/bin/env python3
"""Prepare a pinned SOURCE SUBSET for review/tests, not a Chromium build/rollout."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import urllib.request


class ChromiumPatch:
    MAX_FILE = 2 * 1024 * 1024

    def __init__(self, bundle):
        self.bundle = Path(bundle).resolve(strict=True)
        self.manifest = json.loads((self.bundle / "manifest.json").read_text())
        if self.manifest["schema"] != 1 or not re.fullmatch(r"[a-f0-9]{40}", self.manifest["revision"]):
            raise ValueError("Unsupported Chromium manifest")
        for key in ("sources", "artifacts"):
            entries = self.manifest[key]
            if not isinstance(entries, dict) or not 1 <= len(entries) <= 64:
                raise ValueError("Manifest file count bound")
            for path, digest in entries.items():
                self.safe_path(path)
                if not re.fullmatch(r"[a-f0-9]{64}", digest):
                    raise ValueError("Invalid source digest")
        if set(self.manifest["artifacts"]) != {
                "surface-damage.patch", "overlay/ui/gfx/browserpane_surface_damage.h"}:
            raise ValueError("Unexpected patch artifacts")
        for path, digest in self.manifest["artifacts"].items():
            self.verify_bytes(self.read_regular(self.bundle, path), digest)

    @staticmethod
    def safe_path(path):
        value = PurePosixPath(path)
        if (value.is_absolute() or not path or str(value) != path or "\\" in path
                or any(part in (".", "..", ".git") for part in value.parts)):
            raise ValueError("Unsafe manifest path")
        return value

    @classmethod
    def read_regular(cls, root, relative):
        parts = cls.safe_path(relative).parts
        target = root
        for part in parts:
            target = target / part
            if target.is_symlink():
                raise ValueError("Source/artifact symlinks are not accepted")
        if not target.is_file() or target.stat().st_size > cls.MAX_FILE:
            raise ValueError("Source/artifact file bound")
        return target.read_bytes()

    @classmethod
    def verify_bytes(cls, data, expected):
        if len(data) > cls.MAX_FILE or hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("Pinned content digest mismatch")

    def verify_base(self, source):
        root = Path(source).resolve(strict=True)
        for path, digest in self.manifest["sources"].items():
            self.verify_bytes(self.read_regular(root, path), digest)
        overlay = root / "ui/gfx/browserpane_surface_damage.h"
        if overlay.exists() or overlay.is_symlink():
            raise ValueError("Overlay destination already exists")

    @classmethod
    def fetch(cls, url):
        with urllib.request.urlopen(url, timeout=30) as response:
            data = response.read(cls.MAX_FILE + 1)
        if len(data) > cls.MAX_FILE:
            raise ValueError("Downloaded file bound")
        return data

    @staticmethod
    def git(root, *args):
        result = subprocess.run(["git", *args], cwd=root, capture_output=True,
                                text=True, timeout=15)
        if result.returncode:
            raise RuntimeError("Pinned patch failed: " + result.stderr[-2000:])

    def prepare(self, destination, fetch=None):
        # Exclusive new directory. Never edit, overwrite or clean an existing
        # checkout, and never execute fetched hooks/build scripts.
        requested = Path(destination).absolute()
        root = requested.parent.resolve(strict=True) / requested.name
        if root.exists() or root.is_symlink():
            raise ValueError("Destination must not exist")
        root.mkdir(mode=0o700)
        get = fetch or self.fetch
        for path, digest in self.manifest["sources"].items():
            url = ("https://raw.githubusercontent.com/chromium/chromium/"
                   + self.manifest["revision"] + "/" + path)
            data = get(url)
            self.verify_bytes(data, digest)
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(data)
        self.verify_base(root)
        # Prevent discovery of an unrelated enclosing Git repository.
        self.git(root, "init", "-q")
        patch = str(self.bundle / "surface-damage.patch")
        self.git(root, "apply", "--check", "--whitespace=error", patch)
        self.git(root, "apply", "--whitespace=error", patch)
        for path in self.manifest["artifacts"]:
            if not path.startswith("overlay/"):
                continue
            target = root / path.removeprefix("overlay/")
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(self.read_regular(self.bundle, path))
        self.git(root, "apply", "--reverse", "--check", patch)
        return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--destination", help="New source subset, no full dependency checkout")
    group.add_argument("--verify-base", help="Read-only hash check of an existing source checkout")
    args = parser.parse_args()
    patch = ChromiumPatch(Path(__file__).parent)
    if args.verify_base:
        patch.verify_base(args.verify_base)
        print("pinned_base=verified chromium_build=not_checked")
    else:
        patch.prepare(args.destination)
        print("pinned_patch=applied source_subset_only=true chromium_build=not_checked")


if __name__ == "__main__":
    main()
