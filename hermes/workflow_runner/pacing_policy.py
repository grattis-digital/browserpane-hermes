"""Reviewed, origin-bound pacing values; never ambient environment configuration."""

from urllib.parse import urlsplit

from .contracts import closed, digest, require, url


class PacingPolicy:
    FIELDS = ("schema", "version", "origin", "minIntervalMs", "jitterMs", "maxActions", "windowMs", "maxWaitMs")

    def __init__(self, value, target):
        closed(value, self.FIELDS)
        limits = {"schema": (1, 1), "version": (1, 1000000), "minIntervalMs": (0, 60000),
                  "jitterMs": (0, 5000), "maxActions": (1, 1000), "windowMs": (1000, 3600000),
                  "maxWaitMs": (0, 10000)}
        for field, (low, high) in limits.items():
            require(type(value[field]) is int and low <= value[field] <= high, "INVALID_PACING_POLICY")
        require(value["origin"] == self.origin(target), "PACING_ORIGIN_MISMATCH")
        self._value = dict(value)

    @staticmethod
    def origin(target):
        parsed = urlsplit(url(target))
        try:
            host = parsed.hostname.encode("idna").decode("ascii").lower()
        except UnicodeError as error:
            from .contracts import WorkflowError
            raise WorkflowError("INVALID_PACING_ORIGIN") from error
        if ":" in host:
            host = "[" + host + "]"
        port = parsed.port
        return parsed.scheme + "://" + host + (":" + str(port) if port and port != (443 if parsed.scheme == "https" else 80) else "")

    def data(self):
        return dict(self._value)

    def fingerprint(self):
        return digest(self._value)

    def site_key(self):
        # No URL, page text, credential or workflow binding is stored in the ledger.
        return digest({"origin": self._value["origin"]})
