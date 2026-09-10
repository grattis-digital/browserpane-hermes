"""Immutable execution selection and closed, content-minimized agent surface."""

import json
import os
import tempfile
import unittest

from workflow_fixture import WorkflowFixture
from workflow_runner.catalog import ExecutionCatalog
from workflow_runner.contracts import WorkflowError
from workflow_runner.control import WorkflowController
from workflow_runner.service import WorkflowService


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-catalog-")
        self.addCleanup(self.temp.cleanup)
        self.f = WorkflowFixture(self.temp.name)
        self.catalog = ExecutionCatalog(self.f.root / "catalog", self.f.journal,
            self.f.contract.data()["endpoint"], self.f.downloads, lambda: self.f.now)
        self.service = WorkflowService(self.catalog, self.f.journal, self.f.connect)
        self.addCleanup(self.service.close)
        self.control = WorkflowController(self.service, lambda: self.f.now)

    def register(self):
        run = self.f.approve()
        self.catalog.register(run, self.f.contract)
        return run

    def call(self, args):
        return json.loads(self.control.handle(args))

    def test_discovery_is_lazy_and_omits_private_parameters(self):
        self.assertEqual(self.call({"op": "discover"})["executions"], [])
        self.assertFalse((self.f.root / "catalog").exists())
        self.assertIsNone(self.service._thread)
        run = self.register()
        result = self.call({"op": "discover"})
        self.assertEqual(result["executions"][0]["runId"], run)
        self.assertTrue(result["executions"][0]["runnable"])
        for secret in ("2026-06", "ITEM-0001", "fixture.invalid", "Synthetic account"):
            self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(self.f.calls, [])

    def test_only_explicit_registered_live_approvals_are_discoverable(self):
        run = self.f.approve()
        self.assertEqual(self.call({"op": "run", "run_id": run})["error"], "EXECUTION_NOT_REGISTERED")
        self.f.now += 600
        with self.assertRaisesRegex(WorkflowError, "LIVE_REVIEW_REQUIRED"):
            self.catalog.register(run, self.f.contract)
        self.assertEqual(self.catalog.ids(), [])

    def test_registration_is_private_immutable_and_idempotent(self):
        run = self.register()
        file = self.f.root / "catalog" / (run + ".json")
        original = file.read_bytes()
        self.catalog.register(run, self.f.contract)
        self.assertEqual(original, file.read_bytes())
        self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(file.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.catalog.load(run).fingerprint(), self.f.contract.fingerprint())

    def test_tampered_bindings_fail_before_browser_connection(self):
        run = self.register()
        file = self.f.root / "catalog" / (run + ".json")
        value = json.loads(file.read_text())
        value["contract"]["bindings"]["period"] = "2026-07"
        file.write_text(json.dumps(value))
        self.assertEqual(self.call({"op": "run", "run_id": run})["error"], "BINDING_MISMATCH")
        self.assertEqual(self.f.calls, [])

    def test_endpoint_and_downloads_are_operator_config_not_catalog_authority(self):
        run = self.register()
        for endpoint, downloads in (("http://different.invalid/mcp", self.f.downloads),
                                     (self.f.contract.data()["endpoint"], "/other")):
            catalog = ExecutionCatalog(self.f.root / "catalog", self.f.journal, endpoint, downloads, lambda: self.f.now)
            with self.assertRaisesRegex(WorkflowError, "CONFIGURATION_MISMATCH"):
                catalog.load(run)

    def test_no_approve_scripts_paths_extra_fields_or_unbounded_discovery(self):
        for args in ({"op": "approve"}, {"op": "run", "recipe": {}}, {"op": "status", "run_id": "../file"},
                     {"op": "discover", "offset": True}, {"op": "discover", "offset": 33},
                     {"op": "discover", "endpoint": "https://secret.invalid"}, {"op": []}, []):
            self.assertIn("error", self.call(args))
        for _ in range(17):
            self.register()
        page = self.call({"op": "discover"})
        self.assertEqual(len(page["executions"]), 16)
        self.assertEqual(page["nextOffset"], 16)
        self.assertEqual(len(self.call({"op": "discover", "offset": 16})["executions"]), 1)

    def test_symlinks_and_world_readable_catalog_entries_fail_closed(self):
        run = self.register()
        file = self.f.root / "catalog" / (run + ".json")
        file.chmod(0o644)
        self.assertIn("error", self.call({"op": "status", "run_id": run}))
        file.chmod(0o600)
        other = self.f.root / "external.json"
        file.rename(other)
        file.symlink_to(other)
        self.assertIn("error", self.call({"op": "status", "run_id": run}))
        self.assertEqual(self.f.calls, [])

    def test_cancel_registered_approval_is_durable_after_new_service(self):
        run = self.register()
        self.assertEqual(self.call({"op": "cancel", "run_id": run})["state"], "stopped")
        again = WorkflowService(self.catalog, self.f.journal, self.f.connect)
        self.addCleanup(again.close)
        self.assertEqual(again.execute(run)["state"], "stopped")
        self.assertEqual(self.f.calls, [])
