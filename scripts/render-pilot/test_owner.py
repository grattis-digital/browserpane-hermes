"""Ownership regressions require neither Docker nor a Raspberry Pi."""
import copy
import unittest
from unittest.mock import Mock, patch
from owner import RenderOwner


class OwnerTests(unittest.TestCase):
    def test_diagnostics_and_damage_readback_require_explicit_boolean_flags(self):
        self.assertEqual(RenderOwner.features_from({}), {key: False for key in
            ("damageReadback", "damageAnalysis", "captureTimings", "nativeDamageTrace", "stockGpuTrace", "stockGpuWorkloads")})
        self.assertEqual(RenderOwner.features_from({"damageReadback": True})["damageReadback"], True)
        for value in ("1", 1, None, [], {}):
            for key in ("captureTimings", "damageAnalysis", "damageReadback", "nativeDamageTrace", "stockGpuTrace", "stockGpuWorkloads"):
                with self.assertRaises(AssertionError):
                    RenderOwner.features_from({key: value})

    def test_stock_trace_rejects_missing_workload_and_competing_traces(self):
        for config in ({"stockGpuTrace": True},
                       {"stockGpuTrace": True, "stockGpuWorkloads": True, "nativeDamageTrace": True},
                       {"stockGpuTrace": True, "stockGpuWorkloads": True, "customChromium": {"sha256": "a" * 64}}):
            with self.assertRaises(AssertionError):
                RenderOwner.features_from(config)
        self.assertTrue(RenderOwner.features_from({"stockGpuTrace": True, "stockGpuWorkloads": True})["stockGpuTrace"])

    def fixture(self):
        owner = RenderOwner.__new__(RenderOwner)
        owner.token, owner.containers = "fixture", {"browser": "a" * 64}
        host = {"OomKillDisable": None, "Privileged": False, "Memory": 1610612736}
        owner.expected = {"browser": {"image": "sha256:" + "b" * 64, "host": host, "mounts": []}}
        current = {"Id": "a" * 64, "Image": "sha256:" + "b" * 64,
                   "Config": {"User": "10000:10000", "Labels": {owner.LABEL: "fixture"}},
                   "HostConfig": copy.deepcopy(host), "Mounts": []}
        owner.inspect = lambda *_: current
        return owner, current

    def test_only_equivalent_oom_false_normalization_is_accepted(self):
        owner, current = self.fixture()
        current["HostConfig"]["OomKillDisable"] = False
        self.assertEqual(owner.owned("browser"), current)
        current["HostConfig"]["OomKillDisable"] = True
        with self.assertRaisesRegex(AssertionError, "OomKillDisable"):
            owner.owned("browser")

    def test_foreign_identity_image_label_mount_or_resource_is_rejected(self):
        for mutation in [lambda c: c.update(Id="c" * 64), lambda c: c.update(Image="different"),
                         lambda c: c["Config"]["Labels"].clear(), lambda c: c.update(Mounts=[{}]),
                         lambda c: c["HostConfig"].update(Memory=2147483648)]:
            owner, current = self.fixture()
            mutation(current)
            with self.assertRaises((AssertionError, KeyError)):
                owner.owned("browser")

    def test_lan_approval_is_required_before_any_docker_access(self):
        with patch.object(RenderOwner, "docker") as docker:
            with self.assertRaises(AssertionError):
                RenderOwner({"allowLan": False, "mode": "cpu"})
            docker.assert_not_called()

    def test_failed_container_cleanup_keeps_firewall_restrictions(self):
        owner, current = self.fixture()
        current["Image"] = "foreign"
        owner.volume = owner.network = None
        owner.record = {}
        owner.firewall = Mock()
        owner.save = Mock()
        with self.assertRaises(AssertionError):
            owner.close()
        owner.firewall.close.assert_not_called()
        self.assertFalse(owner.record["cleaned"])
        self.assertTrue(owner.record["cleanupErrors"])


if __name__ == "__main__":
    unittest.main()
