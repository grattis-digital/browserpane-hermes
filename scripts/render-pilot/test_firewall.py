"""No privilege/network needed. Test exact installation/rollback ownership."""
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from firewall import PilotFirewall


class FirewallTests(unittest.TestCase):
    def fixture(self):
        firewall = PilotFirewall("12345678-1234-1234-1234-123456789abc", "192.0.2.10", "192.0.2.20", 24490, 24433)
        self.calls = []
        def command(*args, **kwargs):
            self.calls.append(args)
            return SimpleNamespace(returncode=1 if args == ("-S", firewall.chain) else 0, stdout="")
        firewall.command = command
        return firewall

    def test_scoped_rules_precede_publishing_and_no_global_flush(self):
        firewall = self.fixture()
        firewall.install()
        self.assertEqual(len(firewall.installed_jumps), 2)
        for rule in firewall.jumps:
            self.assertIn("--ctorigdst", rule)
            self.assertIn("192.0.2.10", rule)
            self.assertIn("--ctorigdstport", rule)
        self.assertTrue(all("192.0.2.20/32" in rule for rule in firewall.rules[:-1]))
        self.assertLess(next(i for i, c in enumerate(self.calls) if c[:1] == ("-A",)),
                        next(i for i, c in enumerate(self.calls) if c[:1] == ("-I",)))
        firewall.isolate_bridge("br-123456abcdef")
        firewall.close()
        self.assertFalse(any(c[0] in ("-F", "-P") for c in self.calls))
        self.assertEqual(self.calls[-1], ("-X", firewall.chain))

    def test_partial_install_removes_only_successful_owned_rules(self):
        firewall = self.fixture()
        original = firewall.command
        def command(*args, **kwargs):
            if args[:2] == ("-I", "DOCKER-USER"):
                raise RuntimeError("injected install failure")
            return original(*args, **kwargs)
        firewall.command = command
        with self.assertRaises(RuntimeError):
            firewall.install()
        firewall.close()
        self.assertFalse(any(c[:2] == ("-D", "DOCKER-USER") for c in self.calls))

    def test_counter_scope_and_units(self):
        firewall = self.fixture()
        lines = [f"[{i+1}:{(i+1)*100}] -A {firewall.chain} -m comment --comment {rule[rule.index('--comment')+1]} -j ACCEPT"
                 for i, rule in enumerate(firewall.rules)]
        with patch("firewall.subprocess.run", return_value=SimpleNamespace(stdout="\n".join(lines))):
            counters = firewall.counters()
        self.assertEqual(counters["udp-REPLY"], {"packets": 4, "ipBytes": 400})
        self.assertEqual(len(counters), 5)

    def test_unknown_bridge_and_occupied_chain_rejected(self):
        firewall = self.fixture()
        with self.assertRaises(AssertionError):
            firewall.isolate_bridge("eth0")
        firewall.command = lambda *a, **kw: SimpleNamespace(returncode=0)
        with self.assertRaises(AssertionError):
            firewall.install()
        self.assertFalse(firewall.created)


if __name__ == "__main__":
    unittest.main()
