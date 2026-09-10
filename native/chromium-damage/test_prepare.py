"""Offline preparation/ownership tests. No Chromium checkout or network calls."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("chromium_damage_prepare", Path(__file__).with_name("prepare.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        header = self.bundle / "overlay/ui/gfx/browserpane_surface_damage.h"
        header.parent.mkdir(parents=True)
        header.write_bytes(b"// fixture header\n")
        patch = (b"diff --git a/example.cc b/example.cc\n--- a/example.cc\n+++ b/example.cc\n"
                 b"@@ -1 +1 @@\n-before\n+after\n")
        (self.bundle / "surface-damage.patch").write_bytes(patch)
        self.manifest = {"schema": 1, "revision": "a" * 40, "sources": {"example.cc": digest(b"before\n")},
                         "artifacts": {"surface-damage.patch": digest(patch),
                                       "overlay/ui/gfx/browserpane_surface_damage.h": digest(header.read_bytes())}}
        self.save_manifest()

    def save_manifest(self):
        (self.bundle / "manifest.json").write_text(json.dumps(self.manifest))

    def fetch(self, url):
        self.assertEqual(url, "https://raw.githubusercontent.com/chromium/chromium/" + "a" * 40 + "/example.cc")
        return b"before\n"

    def test_exact_patch_and_overlay_in_exclusive_new_directory(self):
        output = self.root / "new"
        prepared = module.ChromiumPatch(self.bundle).prepare(output, self.fetch)
        self.assertEqual(prepared, output.resolve())
        self.assertEqual((output / "example.cc").read_bytes(), b"after\n")
        self.assertEqual((output / "ui/gfx/browserpane_surface_damage.h").read_bytes(), b"// fixture header\n")
        self.assertEqual(output.stat().st_mode & 0o077, 0)

    def test_existing_or_symlink_destination_is_never_changed(self):
        output = self.root / "existing"
        output.mkdir()
        (output / "keep").write_text("user data")
        link = self.root / "link"
        link.symlink_to(output, target_is_directory=True)
        dangling = self.root / "dangling"
        dangling.symlink_to(self.root / "absent", target_is_directory=True)
        for target in (output, link, dangling):
            with self.subTest(target=target), self.assertRaises(ValueError):
                module.ChromiumPatch(self.bundle).prepare(target, lambda _: self.fail("must not fetch"))
        self.assertEqual((output / "keep").read_text(), "user data")

    def test_wrong_revision_bytes_and_oversized_downloads_fail(self):
        for index, data in enumerate((b"wrong source", b"x" * (module.ChromiumPatch.MAX_FILE + 1))):
            output = self.root / f"bad{index}"
            with self.assertRaises(ValueError):
                module.ChromiumPatch(self.bundle).prepare(output, lambda _: data)
            self.assertFalse((output / "example.cc").exists())
            self.assertFalse((output / ".git").exists())

    def test_tampered_artifact_rejected_before_destination_creation(self):
        (self.bundle / "surface-damage.patch").write_text("tampered")
        with self.assertRaises(ValueError):
            module.ChromiumPatch(self.bundle)

    def test_unsafe_paths_invalid_pins_and_symlink_artifacts_rejected(self):
        original = copy.deepcopy(self.manifest)
        for path in ("../outside", "/absolute", "x/../../outside", ".git/config", "x\\outside"):
            self.manifest["sources"] = {path: digest(b"before\n")}
            self.save_manifest()
            with self.subTest(path=path), self.assertRaises(ValueError):
                module.ChromiumPatch(self.bundle)
        self.manifest = original
        self.manifest["revision"] = "main"
        self.save_manifest()
        with self.assertRaises(ValueError):
            module.ChromiumPatch(self.bundle)
        self.manifest["revision"] = "a" * 40
        self.save_manifest()
        patch = self.bundle / "surface-damage.patch"
        copy_path = self.root / "outside.patch"
        patch.rename(copy_path)
        patch.symlink_to(copy_path)
        with self.assertRaises(ValueError):
            module.ChromiumPatch(self.bundle)

    def test_base_verification_is_read_only_and_rejects_dirty_or_linked_source(self):
        output = self.root / "base"
        output.mkdir()
        source = output / "example.cc"
        source.write_bytes(b"before\n")
        patch = module.ChromiumPatch(self.bundle)
        patch.verify_base(output)
        self.assertEqual(source.read_bytes(), b"before\n")
        source.write_bytes(b"user edit\n")
        with self.assertRaises(ValueError):
            patch.verify_base(output)
        self.assertEqual(source.read_bytes(), b"user edit\n")
        source.rename(output / "saved.cc")
        source.symlink_to(output / "saved.cc")
        with self.assertRaises(ValueError):
            patch.verify_base(output)

    def test_tracked_package_lock_and_feature_remain_explicit(self):
        bundle = Path(__file__).parent
        package = module.ChromiumPatch(bundle)
        self.assertEqual(package.manifest["revision"], "4999cc1efed37c4d91dc4ce6ec4b0a50e2a9a8cb")
        patch = (bundle / "surface-damage.patch").read_text()
        self.assertIn('+             base::FEATURE_DISABLED_BY_DEFAULT)', patch)
        self.assertNotIn('+  capabilities_.supports_post_sub_buffer = true', patch)
        self.assertNotIn('+  if (use_partial_swap_', patch)


if __name__ == "__main__":
    unittest.main()
