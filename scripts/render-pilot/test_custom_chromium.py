"""Contract checks never start a browser or build/download Chromium."""
import unittest
from unittest.mock import Mock
from custom_chromium import CustomChromium


class CustomChromiumTests(unittest.TestCase):
    def test_normal_pilot_is_unchanged(self):
        self.assertIsNone(CustomChromium.parse({}))
        self.assertEqual(CustomChromium.environment(None), [])
        owner = Mock(custom_chromium=None)
        self.assertIsNone(CustomChromium.verify(owner))
        owner.execute.assert_not_called()

    def test_explicit_on_and_off_share_same_binary(self):
        for enabled in (False, True):
            value = {"sha256": "a" * 64, "surfaceDamage": enabled}
            actual = CustomChromium.parse({"mode": "gpu-tail", "customChromium": value})
            self.assertEqual(actual, value)
            self.assertIsNot(actual, value)
            self.assertEqual(CustomChromium.environment(actual), ["-e", "BPANE_CUSTOM_DAMAGE=" + str(int(enabled))])

    def test_malformed_contract_and_wrong_backend_fail(self):
        good = {"sha256": "a" * 64, "surfaceDamage": True}
        for value in (None, False, {}, {**good, "flags": "--no-sandbox"},
                      {**good, "sha256": "a" * 63}, {**good, "sha256": None},
                      {**good, "surfaceDamage": "1"}, {**good, "surfaceDamage": 1}):
            with self.assertRaises(AssertionError):
                CustomChromium.parse({"mode": "gpu-tail", "customChromium": value})
        with self.assertRaises(AssertionError):
            CustomChromium.parse({"mode": "cpu", "customChromium": good})


if __name__ == "__main__":
    unittest.main()
