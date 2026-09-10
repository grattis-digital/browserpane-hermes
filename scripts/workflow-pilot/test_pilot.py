"""Fast harness checks: no Docker, host probes, network or operator state."""

import hashlib
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

from driver import PilotAgent
from owned import OwnedPilot
from run import summary
from trials import PilotTrials


class OwnershipTests(unittest.TestCase):
    def pilot(self, info):
        pilot = OwnedPilot.__new__(OwnedPilot)
        pilot.token = "owned-token"
        pilot.inspect = Mock(return_value=info)
        pilot.docker = Mock()
        return pilot

    def test_unowned_resource_cannot_be_removed(self):
        pilot = self.pilot({"Config": {"Labels": {OwnedPilot.LABEL: "different-token"}}})
        pilot.containers = {"browser": "existing-id"}
        with self.assertRaises(AssertionError):
            pilot.remove("browser")
        pilot.docker.assert_not_called()

    def test_published_or_privileged_container_is_not_accepted(self):
        for host in ({"PortBindings": {"80/tcp": []}, "Privileged": False},
                     {"PortBindings": {}, "Privileged": True}):
            pilot = self.pilot({"Config": {"Labels": {OwnedPilot.LABEL: "owned-token"}}, "HostConfig": host})
            with self.assertRaises(AssertionError):
                pilot.owned("container", "test-id")

    def test_removal_uses_exact_validated_identifier(self):
        pilot = self.pilot({"Config": {"Labels": {OwnedPilot.LABEL: "owned-token"}},
                            "HostConfig": {"PortBindings": {}, "Privileged": False}})
        pilot.containers = {"browser": "owned-id"}
        pilot.remove("browser")
        self.assertEqual(pilot.docker.call_args_list[0].args, ("stop", "--time=45", "owned-id"))
        self.assertEqual(pilot.docker.call_args_list[1].args, ("rm", "owned-id"))
        self.assertEqual(pilot.containers, {})


class OracleTests(unittest.TestCase):
    def setUp(self):
        self.trials = PilotTrials.__new__(PilotTrials)
        self.trials.previous = set()
        self.body = "period,code,quantity\n2026-01,ITEM-0001,7\n"
        self.evidence = {"files": {"report-2026-01.csv": self.body}, "tabs": 1,
                         "state": {"clicks": 1, "trusted": True}}
        self.trials.probe = Mock(return_value=self.evidence)
        self.trials.control = Mock(return_value={"requests": 1, "period": "2026-01"})
        self.result = {"verified": True, "artifact": {"sha256": hashlib.sha256(self.body.encode()).hexdigest()}}

    def verify(self):
        return self.trials.verify("2026-01", [{"code": "ITEM-0001", "quantity": 7}], self.result)

    def test_exact_csv_and_trusted_single_input_pass(self):
        self.assertTrue(self.verify()["trusted"])

    def test_unverified_hash_mismatch_and_duplicate_exports_fail(self):
        self.result["verified"] = False
        with self.assertRaises(AssertionError):
            self.verify()
        self.result["verified"] = True
        self.result["artifact"]["sha256"] = "wrong"
        with self.assertRaises(AssertionError):
            self.verify()
        self.result["artifact"]["sha256"] = hashlib.sha256(self.body.encode()).hexdigest()
        self.evidence["files"]["report-2026-01 (1).csv"] = self.body
        with self.assertRaises(AssertionError):
            self.verify()

    def test_untrusted_or_repeated_input_fails(self):
        for clicks, trusted in ((2, True), (1, False)):
            self.evidence["state"] = {"clicks": clicks, "trusted": trusted}
            with self.assertRaises(AssertionError):
                self.verify()

    def test_csv_wrong_rows_fail_even_with_matching_hash(self):
        wrong = self.body.replace(",7\n", ",8\n")
        self.evidence["files"]["report-2026-01.csv"] = wrong
        self.result["artifact"]["sha256"] = hashlib.sha256(wrong.encode()).hexdigest()
        with self.assertRaises(AssertionError):
            self.verify()

    def test_summary_keeps_arms_separate_and_nearest_rank_p95(self):
        rows = []
        for mode, offset in (("cold", 100), ("warm", 0)):
            for value in (1, 2, 3, 4):
                row = {key: value + offset for key in ("wallMs", "executionMs", "mcpMs", "mcpCalls", "responseJsonBytes", "polls")}
                rows.append({**row, "mode": mode, "cpuMs": {"browser": value, "hermes": value}})
        result = summary(rows)
        self.assertEqual(result["warm"]["wallMs"], {"median": 2.5, "p95": 4})
        self.assertEqual(result["cold"]["wallMs"], {"median": 102.5, "p95": 104})


class StressDriverTests(unittest.TestCase):
    @patch("driver.subprocess.Popen")
    @patch.object(PilotAgent, "read", return_value={"ready": True})
    @patch.object(Path, "read_text", return_value="/* Fixed owned test helper */")
    def test_diagnostic_uses_only_owned_browser_and_fixed_helper(self, source, read, spawn):
        owner = Mock()
        owner.code = Path(__file__).resolve().parent
        owner.containers = {"browser": "owned-browser", "hermes": "owned-hermes"}
        PilotAgent(owner, "stress")
        owner.owned.assert_called_once_with("container", "owned-browser")
        command = spawn.call_args.args[0]
        self.assertEqual(command[:7], ["docker", "exec", "-i", "owned-browser", "node", "--input-type=module", "-e"])
        self.assertIn("await new PilotStress().serve();", command[7])
        self.assertNotIn("owned-hermes", command)

    @patch("driver.subprocess.Popen")
    def test_unowned_diagnostic_never_starts_a_process(self, spawn):
        owner = Mock()
        owner.containers = {"browser": "unowned"}
        owner.owned.side_effect = AssertionError("not owned")
        with self.assertRaises(AssertionError):
            PilotAgent(owner, "stress")
        spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
