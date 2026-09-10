"""Closed recipe and artifact boundaries on disposable local files."""

import copy
import os
from pathlib import Path
import tempfile
import unittest

from workflow_fixture import WorkflowFixture
from workflow_runner.contracts import ReportContract, WorkflowError, digest
from workflow_runner.private_files import PrivateFiles


class RecipeBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-recipe-boundary-")
        self.addCleanup(self.temp.cleanup)
        self.f = WorkflowFixture(self.temp.name)

    def contract(self, recipe=None, bindings=None, **changes):
        return ReportContract(recipe or self.f.recipe, bindings or self.f.bindings,
            changes.get("endpoint", "http://127.0.0.1:8931/mcp"), changes.get("downloads", str(self.f.downloads)))

    def test_version_parameters_connection_and_targets_are_all_bound(self):
        original = self.f.contract.fingerprint()
        for field, value in (("version", 2), ("url", "https://fixture.invalid/other"), ("readyText", "Another result")):
            recipe = {**self.f.recipe, field: value}
            self.assertNotEqual(self.contract(recipe=recipe).fingerprint(), original)
        changed = {**self.f.bindings, "period": "2026-07"}
        self.assertNotEqual(self.contract(bindings=changed).fingerprint(), original)
        self.assertNotEqual(self.contract(endpoint="http://127.0.0.1:8932/mcp").fingerprint(), original)
        self.assertNotEqual(self.contract(downloads=str(self.f.root / "other")).fingerprint(), original)

    def test_untrusted_extra_fields_scripts_credentials_and_live_refs_are_rejected(self):
        for field in ("script", "steps", "approval", "lease", "request", "onError"):
            with self.assertRaises(WorkflowError):
                self.contract(recipe={**self.f.recipe, field: "untrusted"})
        for value in ("javascript:alert(1)", "file:///private", "https://user:secret@fixture.invalid/", "https://fixture.invalid/?token=secret"):
            with self.assertRaises(WorkflowError):
                self.contract(recipe={**self.f.recipe, "url": value})
        for value in (True, 0, 1.0, "1"):
            with self.assertRaises(WorkflowError):
                self.contract(recipe={**self.f.recipe, "version": value})

    def test_invalid_bindings_and_ambiguous_target_contracts_are_rejected(self):
        for period in ("2026-13", "2026-00", "2026-1", "=1+1", "2026-01\n"):
            with self.assertRaises(WorkflowError):
                self.contract(bindings={**self.f.bindings, "period": period})
        for quantity in (True, -1, float("inf"), 1.1):
            with self.assertRaises(WorkflowError):
                self.contract(bindings={"period": "2026-06", "rows": [{"code": "ITEM-0001", "quantity": quantity}]})
        target = {"role": "button", "name": "Pay now"}
        with self.assertRaises(WorkflowError):
            self.contract(recipe={**self.f.recipe, "exportTarget": target})
        bindings = copy.deepcopy(self.f.bindings)
        bindings["rows"] *= 2
        with self.assertRaises(WorkflowError):
            self.contract(bindings=bindings)

    def test_contract_is_copied_and_review_has_no_filesystem_side_effect(self):
        before = list(self.f.root.iterdir())
        expected = self.f.contract.fingerprint()
        data = self.f.contract.data()
        data["recipe"]["version"] = 2
        self.assertEqual(self.f.contract.review()["digest"], expected)
        self.assertEqual(list(self.f.root.iterdir()), before)

    def test_existing_artifacts_are_never_selected_and_concurrent_downloads_are_ambiguous(self):
        old = self.f.downloads / "report-2026-06.csv"
        old.write_text("old")
        before = self.f.artifacts.snapshot()
        self.assertIsNone(self.f.artifacts.candidate(before, "2026-06"))
        (self.f.downloads / "report-2026-06 (1).csv").write_text("new")
        candidate = self.f.artifacts.candidate(before, "2026-06")
        self.assertEqual(candidate["text"], "new")
        (self.f.downloads / "report-2026-06 (2).csv").write_text("other")
        with self.assertRaisesRegex(WorkflowError, "AMBIGUOUS_ARTIFACT"):
            self.f.artifacts.candidate(before, "2026-06")

    def test_file_mutation_symlinks_and_oversized_reports_fail_closed(self):
        path = self.f.downloads / "report-2026-06.csv"
        path.write_text("old")
        before = self.f.artifacts.snapshot()
        path.write_text("changed")
        with self.assertRaisesRegex(WorkflowError, "ARTIFACT_SET_CHANGED"):
            self.f.artifacts.candidate(before, "2026-06")
        path.unlink()
        before = self.f.artifacts.snapshot()
        external = self.f.root / "private-secret"
        external.write_text("SECRET")
        path.symlink_to(external)
        with self.assertRaisesRegex(WorkflowError, "UNSAFE_ARTIFACT_ENTRY"):
            self.f.artifacts.candidate(before, "2026-06")
        path.unlink()
        path.write_bytes(b"x" * 32769)
        with self.assertRaisesRegex(WorkflowError, "ARTIFACT_SIZE"):
            self.f.artifacts.candidate(before, "2026-06")

    def test_pending_wrong_or_preexisting_download_metadata_is_not_proof(self):
        before = self.f.artifacts.snapshot()
        path = self.f.downloads / "report-2026-06.csv"
        path.write_text("period,code,quantity\n2026-06,ITEM-0001,6\n")
        candidate = self.f.artifacts.candidate(before, "2026-06")
        complete = {"file": str(path), "status": "complete"}
        for records, previous in (([], []), ([{**complete, "status": "pending"}], []),
                                  ([{**complete, "file": "/other/file"}], []), ([complete], [digest(complete)])):
            with self.assertRaisesRegex(WorkflowError, "DOWNLOAD_NOT_CORRELATED"):
                self.f.artifacts.verify(self.f.bindings, candidate, records, previous)

    def test_unsafe_journal_roots_and_linked_databases_are_rejected(self):
        external = self.f.root / "external"
        external.mkdir(mode=0o700)
        root = self.f.root / "linked"
        root.symlink_to(external, target_is_directory=True)
        with self.assertRaises(WorkflowError):
            PrivateFiles(root).open("journal.sqlite3")
        files = PrivateFiles(self.f.root / "safe")
        files.prepare()
        target = external / "database"
        target.touch(mode=0o600)
        os.link(target, files.root / "journal.sqlite3")
        with self.assertRaises(WorkflowError):
            files.open("journal.sqlite3")
