"""Explicit custom-binary A/B contract, not arbitrary Chromium flags."""
import re


class CustomChromium:
    @staticmethod
    def parse(config):
        if "customChromium" not in config:
            return None
        value = config["customChromium"]
        assert type(value) is dict and set(value) == {"sha256", "surfaceDamage"}, "Invalid custom Chromium contract"
        assert type(value["surfaceDamage"]) is bool, "Surface damage flag must be boolean"
        assert type(value["sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]), "Binary digest required"
        assert config["mode"] == "gpu-tail", "Custom damage qualification requires the experimental GPU pipeline"
        return dict(value)

    @staticmethod
    def environment(contract):
        if contract is None:
            return []
        return ["-e", "BPANE_CUSTOM_DAMAGE=" + str(int(contract["surfaceDamage"]))]

    @staticmethod
    def verify(owner):
        if owner.custom_chromium is None:
            return None
        import json
        return json.loads(owner.execute("node", "/pilot/custom-chromium-check.mjs",
            owner.token, json.dumps(owner.custom_chromium), timeout=30))
