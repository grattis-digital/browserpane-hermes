"""Publish first-start configuration atomically; never overwrite operator state."""

import os
from pathlib import Path
import tempfile


def seed_config(home: Path, template: Path) -> bool:
    home.mkdir(parents=True, exist_ok=True)
    target = home / "config.yaml"
    if target.exists() or target.is_symlink():
        if not target.is_file():
            raise ValueError("HERMES_HOME/config.yaml must be a readable regular file")
        return False
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".config-seed-", dir=home, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(template.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        try:
            # Atomic no-clobber publication; concurrent first starts cannot truncate it.
            os.link(temporary, target)
            return True
        except FileExistsError:
            return False
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    seed_config(Path(os.environ.get("HERMES_HOME", "/opt/data")), Path(__file__).with_name("config.yaml"))
