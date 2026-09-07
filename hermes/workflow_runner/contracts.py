"""Closed, data-only recipe. No scripts, expressions, arbitrary steps or retries."""

import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


class WorkflowError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code="INVALID_CONTRACT"):
    if not condition:
        raise WorkflowError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def closed(value, fields):
    require(type(value) is dict and set(value) == set(fields))


def text(value, maximum=200):
    require(isinstance(value, str) and 0 < len(value) <= maximum and all(ord(c) >= 32 for c in value))
    return value


def url(value):
    text(value, 2048)
    parsed = urlsplit(value)
    require(" " not in value and parsed.scheme in ("http", "https") and parsed.hostname and not parsed.username
            and not parsed.password and not parsed.query and not parsed.fragment and "\\" not in value)
    require(parsed.port is None or 0 < parsed.port <= 65535)
    return value


class ReportContract:
    def __init__(self, recipe, bindings, endpoint, downloads, *, pacing=None):
        closed(recipe, ("schema", "id", "version", "url", "marker", "periodTarget", "exportTarget", "readyText", "verifier"))
        require(type(recipe["schema"]) is int and recipe["schema"] == 1)
        require(re.fullmatch(r"[a-z][a-z0-9-]{0,47}", text(recipe["id"])))
        require(type(recipe["version"]) is int and 1 <= recipe["version"] <= 1000000)
        require(recipe["verifier"] == "report-csv-v1")
        url(recipe["url"])
        for field, role in (("marker", "heading"), ("periodTarget", "textbox"), ("exportTarget", "link")):
            closed(recipe[field], ("role", "name"))
            require(recipe[field]["role"] == role)
            text(recipe[field]["name"])
        text(recipe["readyText"])
        closed(bindings, ("period", "rows"))
        require(re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", text(bindings["period"])))
        require(type(bindings["rows"]) is list and 1 <= len(bindings["rows"]) <= 1000)
        seen = set()
        for row in bindings["rows"]:
            closed(row, ("code", "quantity"))
            require(re.fullmatch(r"ITEM-\d{4}", text(row["code"])))
            require(row["code"] not in seen and type(row["quantity"]) is int and 0 <= row["quantity"] <= 9007199254740991)
            seen.add(row["code"])
        expected_csv = "period,code,quantity\n" + "".join(f"{bindings['period']},{row['code']},{row['quantity']}\n" for row in bindings["rows"])
        require(len(expected_csv.encode()) <= 32768)
        url(endpoint)
        require(urlsplit(endpoint).path.endswith("/mcp"))
        text(str(downloads), 1024)
        require(Path(downloads).is_absolute())
        # Frozen private inputs. The optional catalog retains these; the journal retains only fingerprints.
        self._data = json.loads(canonical({"runnerContract": 1, "recipe": recipe, "bindings": bindings,
                                         "endpoint": endpoint, "downloads": str(downloads)}))
        if pacing is not None:
            from .pacing_policy import PacingPolicy
            self._data["pacing"] = PacingPolicy(pacing, recipe["url"]).data()

    def data(self):
        return json.loads(canonical(self._data))

    def fingerprint(self):
        return digest(self._data)

    def review(self):
        return {"digest": self.fingerprint(), **self.data(), "effect": "Navigate existing tab, fill reporting period, click download link once",
                "limits": "Supervised download only; review is not authentication or a browser reservation. No automatic retries or repair."}
