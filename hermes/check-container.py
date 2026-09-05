#!/usr/bin/env python3
"""Qualify a locally built image using owned disposable resources, with no WAN/model calls.

Usage: python3 hermes/check-container.py --image browserpane-hermes-agent:bundle-test
"""

import argparse
import json
from pathlib import Path
import subprocess
import time
import uuid


REVISION = "ee5b5ec21e576ccf9b941f9ff71330418415a5cb"
LABEL = "io.browserpane.test.hermes"


def docker(*args, timeout=120):
    result = subprocess.run(["docker", *args], check=True, capture_output=True, text=True, timeout=timeout)
    return result.stdout.strip()


def inspect(kind, identifier):
    return json.loads(docker(kind, "inspect", identifier))[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    image = inspect("image", args.image)
    assert image["Config"]["Labels"].get("io.browserpane.hermes.revision") == REVISION
    assert image["Config"]["User"] == "10000:10000"
    image_id = image["Id"]
    token = uuid.uuid4().hex[:16]
    name = f"bph-hermes-test-{token}"
    network = None
    volumes = []
    containers = []
    report = {"image": image_id, "architecture": image["Architecture"], "hermesRevision": REVISION}

    def owned(kind, identifier):
        info = inspect(kind, identifier)
        labels = info["Config"]["Labels"] if kind == "container" else info["Labels"]
        assert labels.get(LABEL) == token, f"Refusing action on unowned {kind}"
        return info

    def create_container(role, extra=(), command=()):
        container = docker("create", "--name", f"{name}-{role}", "--label", f"{LABEL}={token}",
                           "--network", network, "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                           *extra, image_id, *command)
        containers.append(container)
        info = owned("container", container)
        assert info["Image"] == image_id and not info["HostConfig"]["PortBindings"]
        docker("start", container)
        return container

    def wait_healthy(container):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            state = owned("container", container)["State"]
            assert state["Running"], "Gateway exited during startup"
            check = subprocess.run(["docker", "exec", container, "python", "/opt/hermes-bundle/healthcheck.py"],
                                   capture_output=True, text=True, timeout=15)
            if check.returncode == 0:
                return
            time.sleep(1)
        raise AssertionError("Gateway did not become healthy within 180 seconds")

    try:
        network = docker("network", "create", "--internal", "--label", f"{LABEL}={token}", name)
        assert owned("network", network)["Internal"]
        for suffix in ("data", "shared"):
            volume = docker("volume", "create", "--label", f"{LABEL}={token}", f"{name}-{suffix}")
            volumes.append(volume)
            owned("volume", volume)
        fixture_code = Path(__file__).with_name("mcp_fixture.py").read_text(encoding="utf-8")
        create_container("fixture", ("--network-alias", "browserpane", "--entrypoint", "python"), ("-u", "-c", fixture_code))
        mounts = ("--mount", f"type=volume,src={volumes[0]},dst=/opt/data",
                  "--mount", f"type=volume,src={volumes[1]},dst=/shared")
        agent = create_container("agent", mounts)
        wait_healthy(agent)
        report["freshGateway"] = "healthy without credentials or messaging platforms"
        owned("container", agent)
        help_text = docker("exec", agent, "hermes", "--cli", "--help")
        assert "--cli" in help_text and "gateway" in help_text
        report["classicCli"] = "help entrypoint passed without a model request"
        output = docker("exec", agent, "python", "/opt/hermes-bundle/verify.py", "--mcp", timeout=180)
        # Hermes may emit a human-readable MCP startup line before our JSON.
        marker = '{\n  "hermesRevision":'
        assert marker in output, "Image verification did not produce its JSON report"
        report["verification"] = json.loads(output[output.index(marker):])
        marker_code = "from pathlib import Path; import os; assert os.getuid()==10000; Path('/shared/persistence-marker').write_text('synthetic'); p=Path('/opt/data/config.yaml'); p.write_text(p.read_text()+'\\n# synthetic operator customization\\n'); Path('/opt/data/.env').write_text('BPH_SYNTHETIC_TEST=preserved\\n')"
        docker("exec", agent, "python", "-c", marker_code)
        owned("container", agent)
        docker("stop", "--time", "30", agent, timeout=45)
        owned("container", agent)
        docker("start", agent)
        wait_healthy(agent)
        report["restart"] = "healthy"
        owned("container", agent)
        docker("stop", "--time", "30", agent, timeout=45)
        owned("container", agent)
        docker("rm", agent)
        containers.remove(agent)
        agent = create_container("recreated", mounts)
        wait_healthy(agent)
        owned("container", agent)
        docker("exec", agent, "python", "-c", "from pathlib import Path; assert Path('/shared/persistence-marker').read_text()=='synthetic'; assert '# synthetic operator customization' in Path('/opt/data/config.yaml').read_text(); assert Path('/opt/data/.env').read_text()=='BPH_SYNTHETIC_TEST=preserved\\n'")
        report["recreate"] = "shared file, operator config and synthetic env preserved"
        print(json.dumps(report, indent=2))
    finally:
        for container in reversed(containers):
            owned("container", container)
            docker("rm", "--force", container)
        for volume in reversed(volumes):
            owned("volume", volume)
            docker("volume", "rm", volume)
        if network:
            owned("network", network)
            docker("network", "rm", network)


if __name__ == "__main__":
    main()
