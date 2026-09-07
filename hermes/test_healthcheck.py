"""Probe keeps upstream liveness checks; package import side effects are unnecessary."""

import importlib.util
import sys
import tempfile
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import healthcheck


class HealthcheckTests(unittest.TestCase):
    def test_running_and_degraded_need_a_live_upstream_verified_pid(self):
        for state in ("running", "degraded", "starting", "stopped", None):
            for pid in (None, 7):
                status = Mock()
                status.read_runtime_status.return_value = {"gateway_state": state}
                status.get_running_pid.return_value = pid
                with patch.object(healthcheck, "load_status", return_value=status):
                    self.assertEqual(healthcheck.healthy(), state in ("running", "degraded") and pid is not None)
                if state in ("running", "degraded"):
                    status.get_running_pid.assert_called_once_with(cleanup_stale=False)
                else:
                    status.get_running_pid.assert_not_called()

    def test_absent_state_is_unhealthy_without_cleanup(self):
        status = Mock()
        status.read_runtime_status.return_value = None
        with patch.object(healthcheck, "load_status", return_value=status):
            self.assertFalse(healthcheck.healthy())
        status.get_running_pid.assert_not_called()

    def test_fixed_source_load_has_module_metadata_and_does_not_import_package(self):
        healthcheck.load_status.cache_clear()
        name = "_browserpane_gateway_health_status"
        self.addCleanup(healthcheck.load_status.cache_clear)
        self.addCleanup(sys.modules.pop, name, None)
        with tempfile.TemporaryDirectory(prefix="bph-health-source-") as directory:
            source = Path(directory) / "status.py"
            source.write_text("from dataclasses import dataclass\n@dataclass\nclass Record:\n    pid: int\n")
            spec = importlib.util.spec_from_file_location(name, source)
            with patch.object(healthcheck.importlib.util, "spec_from_file_location", return_value=spec) as factory:
                module = healthcheck.load_status()
                self.assertEqual(module.Record(7).pid, 7)
                self.assertIs(module, healthcheck.load_status())
                factory.assert_called_once_with(name, "/opt/hermes/gateway/status.py")

    def test_broken_source_fails_closed_without_a_cached_partial_module(self):
        healthcheck.load_status.cache_clear()
        name = "_browserpane_gateway_health_status"
        spec = importlib.util.spec_from_file_location(name, "/nonexistent/bph-health-status.py")
        with patch.object(healthcheck.importlib.util, "spec_from_file_location", return_value=spec):
            with self.assertRaises(FileNotFoundError):
                healthcheck.healthy()
        self.assertNotIn(name, sys.modules)
        self.assertEqual(healthcheck.load_status.cache_info().currsize, 0)
