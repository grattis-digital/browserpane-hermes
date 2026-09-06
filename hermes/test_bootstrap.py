"""Standard-library tests; no Docker, network, credentials or model required."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import stat
import tempfile
import unittest

from bootstrap import seed_config


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="hermes-seed-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.home = self.root / "profile"
        self.template = self.root / "template.yaml"
        self.template.write_text("mcp_servers:\n  browserpane: {}\n", encoding="utf-8")

    def test_first_start_is_private_and_exact(self):
        self.assertTrue(seed_config(self.home, self.template))
        target = self.home / "config.yaml"
        self.assertEqual(target.read_bytes(), self.template.read_bytes())
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertEqual(list(self.home.glob(".config-seed-*")), [])

    def test_existing_operator_state_is_never_overwritten(self):
        self.home.mkdir()
        target = self.home / "config.yaml"
        target.write_text("model: {default: operator-choice}\n", encoding="utf-8")
        credentials = self.home / ".env"
        credentials.write_text("SYNTHETIC_TEST_VALUE=preserve-me\n", encoding="utf-8")
        before = target.read_bytes(), credentials.read_bytes()
        self.assertFalse(seed_config(self.home, self.template))
        self.assertEqual((target.read_bytes(), credentials.read_bytes()), before)

    def test_concurrent_seeds_publish_one_complete_file(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: seed_config(self.home, self.template), range(32)))
        self.assertEqual(sum(results), 1)
        self.assertEqual((self.home / "config.yaml").read_bytes(), self.template.read_bytes())
        self.assertEqual(list(self.home.glob(".config-seed-*")), [])

    def test_failed_template_read_leaves_no_partial_config(self):
        with self.assertRaises(FileNotFoundError):
            seed_config(self.home, self.root / "missing")
        self.assertFalse((self.home / "config.yaml").exists())
        self.assertEqual(list(self.home.glob(".config-seed-*")), [])

    def test_regular_symlink_preserved_without_following_for_write(self):
        self.home.mkdir()
        external = self.root / "operator.yaml"
        external.write_text("operator: config\n", encoding="utf-8")
        (self.home / "config.yaml").symlink_to(external)
        self.assertFalse(seed_config(self.home, self.template))
        self.assertEqual(external.read_text(), "operator: config\n")

    def test_dangling_symlink_or_directory_fails_without_replacement(self):
        self.home.mkdir()
        target = self.home / "config.yaml"
        target.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError):
            seed_config(self.home, self.template)
        self.assertTrue(target.is_symlink())
        target.unlink()
        target.mkdir()
        with self.assertRaises(ValueError):
            seed_config(self.home, self.template)
        self.assertTrue(target.is_dir())


if __name__ == "__main__":
    unittest.main()
