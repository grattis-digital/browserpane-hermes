"""Closed policy, origin scope, approval binding and unchanged legacy defaults."""

import asyncio
import json
import tempfile
import unittest
from unittest.mock import patch

from pacing_fixture import PacingFixture
from workflow_fixture import WorkflowFixture
from workflow_runner.catalog import ExecutionCatalog
from workflow_runner.contracts import ReportContract, WorkflowError, digest
from workflow_runner.pacing_policy import PacingPolicy
from workflow_runner.pacing_runtime import PacingRuntime
from workflow_runner.runner import ReportRunner


class PacingPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-pacing-policy-")
        self.addCleanup(self.temp.cleanup)
        self.f = PacingFixture(self.temp.name)

    def test_closed_integer_limits_reject_coercions_unbounded_and_unknown_values(self):
        for field in ("minIntervalMs", "jitterMs", "maxActions", "windowMs", "maxWaitMs", "version", "schema"):
            for value in (True, None, -1, 0.5, float("inf"), float("nan"), "1", 100000000):
                with self.subTest(field=field, value=value), self.assertRaises(WorkflowError):
                    PacingPolicy({**self.f.policy, field: value}, self.f.recipe["url"])
        for value in ({}, {**self.f.policy, "script": "sleep forever"}, {**self.f.policy, "maxActions": 0}):
            with self.assertRaises(WorkflowError):
                PacingPolicy(value, self.f.recipe["url"])

    def test_origin_is_explicit_and_canonical_not_a_url_prefix(self):
        for origin in ("https://fixture.invalid.evil", "http://fixture.invalid", "https://fixture.invalid/",
                       "https://fixture.invalid:443", "*", None, ["https://fixture.invalid"]):
            with self.assertRaisesRegex(WorkflowError, "PACING_ORIGIN_MISMATCH"):
                PacingPolicy({**self.f.policy, "origin": origin}, self.f.recipe["url"])
        self.assertEqual(PacingPolicy.origin("https://FIXTURE.invalid:443/report"), "https://fixture.invalid")
        self.assertEqual(PacingPolicy.origin("http://[::1]:9130/report"), "http://[::1]:9130")
        self.assertEqual(PacingPolicy.origin("https://bücher.invalid/report"), "https://xn--bcher-kva.invalid")

    def test_policy_copy_and_every_field_are_bound_to_review_digest(self):
        original = self.f.contract.fingerprint()
        for field in ("minIntervalMs", "jitterMs", "maxActions", "windowMs", "maxWaitMs", "version"):
            values = {**self.f.policy, field: self.f.policy[field] + 1}
            changed = ReportContract(self.f.recipe, self.f.bindings, self.f.contract.data()["endpoint"],
                                     str(self.f.downloads), pacing=values)
            self.assertNotEqual(changed.fingerprint(), original)
        data = self.f.contract.data()
        data["pacing"]["maxWaitMs"] = 0
        self.assertEqual(self.f.contract.fingerprint(), original)
        self.assertEqual(self.f.contract.review()["pacing"], self.f.policy)

    def test_catalog_preserves_approved_policy_and_rejects_removal_or_tampering(self):
        catalog = ExecutionCatalog(self.f.root / "catalog", self.f.journal,
            self.f.contract.data()["endpoint"], self.f.downloads, lambda: self.f.now)
        run = self.f.approve()
        catalog.register(run, self.f.contract)
        self.assertEqual(catalog.load(run).data()["pacing"], self.f.policy)
        path = self.f.root / "catalog" / (run + ".json")
        original = path.read_text()
        for policy in (None, {**self.f.policy, "maxWaitMs": 0}, "remove"):
            data = json.loads(original)
            if policy == "remove":
                del data["contract"]["pacing"]
            else:
                data["contract"]["pacing"] = policy
            path.write_text(json.dumps(data))
            with self.assertRaises(WorkflowError):
                catalog.load(run)
        self.assertEqual(self.f.calls, [])

    def test_enabled_contract_cannot_silently_run_without_its_pacer(self):
        with self.assertRaisesRegex(WorkflowError, "PACING_CONFIGURATION_MISMATCH"):
            ReportRunner(self.f.contract, self.f.journal, self.f.artifacts, self.f.connect,
                         lambda: self.f.now, self.f.sleep)

    def test_standard_fixture_is_explicitly_off_ignores_ambient_flags_and_has_no_policy_work(self):
        with tempfile.TemporaryDirectory(prefix="bph-unpaced-") as root:
            f = WorkflowFixture(root)
            expected = {"runnerContract": 1, "recipe": f.recipe, "bindings": f.bindings,
                        "endpoint": "http://127.0.0.1:8931/mcp", "downloads": str(f.downloads)}
            self.assertEqual(f.contract.fingerprint(), digest(expected))
            forbidden = lambda *args: self.fail("Off policy invoked clock, randomness or persistence")
            with patch.dict("os.environ", {"BPANE_PACING": "on", "WORKFLOW_PACING": "on"}), \
                    patch("workflow_runner.pacing_runtime.PacingLedger", side_effect=forbidden):
                self.assertIsNone(PacingRuntime.create(f.contract, f.journal, forbidden, forbidden, forbidden, forbidden))
                result = asyncio.run(f.runner().execute(f.approve()))
            self.assertTrue(result["verified"])
            self.assertEqual(result["policyWaitMs"], 0)
            self.assertEqual(len(f.calls), 5)
            self.assertFalse((f.root / "workflow-pacing").exists())
