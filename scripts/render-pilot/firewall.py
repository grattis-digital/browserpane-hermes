"""Explicitly approved test-port rules. Never flush/reload an existing chain."""
import ipaddress
import re
import subprocess


class PilotFirewall:
    def __init__(self, token, host, client, tcp, udp):
        assert re.fullmatch(r"[a-f0-9-]{36}", token)
        self.host, self.client = str(ipaddress.IPv4Address(host)), str(ipaddress.IPv4Address(client))
        assert self.host != self.client and all(1024 <= p <= 65535 for p in (tcp, udp)) and tcp != udp
        self.chain, self.comment = "BPHR" + token.replace("-", "")[:16], "bph-render-" + token
        self.jumps, self.rules = [], []
        for protocol, port in (("tcp", tcp), ("udp", udp)):
            self.jumps.append(["-p", protocol, "-m", "conntrack", "--ctorigdst", self.host,
                "--ctorigdstport", str(port), "-m", "comment", "--comment", self.comment, "-j", self.chain])
            for direction, address_flag in (("ORIGINAL", "-s"), ("REPLY", "-d")):
                self.rules.append(["-p", protocol, address_flag, self.client + "/32", "-m", "conntrack",
                    "--ctdir", direction, "-m", "comment", "--comment", self.comment + "-" + protocol + "-" + direction,
                    "-j", "ACCEPT"])
        self.rules.append(["-m", "comment", "--comment", self.comment + "-deny", "-j", "DROP"])
        self.created, self.installed_rules, self.installed_jumps = False, [], []
        self.bridge_rules = []

    @staticmethod
    def command(*args, check=True):
        result = subprocess.run(["iptables", "-w", "5", "-t", "filter", *args], capture_output=True, text=True, timeout=10)
        if check and result.returncode:
            raise RuntimeError("Scoped firewall operation failed: " + result.stderr[-1000:])
        return result

    def install(self):
        self.command("-S", "DOCKER-USER")  # Do not invent the host's firewall integration.
        assert self.command("-S", self.chain, check=False).returncode != 0, "Existing test chain"
        self.command("-N", self.chain)
        self.created = True
        for rule in self.rules:
            self.command("-A", self.chain, *rule)
            self.installed_rules.append(rule)
        for rule in self.jumps:
            # Before established-flow accepts; only these two original destinations.
            self.command("-I", "DOCKER-USER", "1", *rule)
            self.installed_jumps.append(rule)

    def counters(self):
        for rule in self.installed_rules:
            self.command("-C", self.chain, *rule)
        result = subprocess.run(["iptables-save", "-c", "-t", "filter"], text=True, capture_output=True, timeout=10, check=True)
        values = {}
        for line in result.stdout.splitlines():
            if " -A " + self.chain + " " not in line:
                continue
            match = re.match(r"\[(\d+):(\d+)\]", line)
            assert match and self.comment in line
            name = line.split(self.comment + "-", 1)[1].split()[0].strip('"')
            values[name] = {"packets": int(match[1]), "ipBytes": int(match[2])}
        assert len(values) == len(self.rules)
        return values

    def isolate_bridge(self, bridge):
        assert re.fullmatch(r"br-[a-f0-9]{12}", bridge)
        # Only replies admitted by the two endpoint rules can leave this bridge.
        # INPUT also blocks direct access to host-local services. No global policy change.
        for chain, position, interface in (("DOCKER-USER", "3", "-i"), ("DOCKER-USER", "3", "-o"), ("INPUT", "1", "-i")):
            rule = [interface, bridge, "-m", "comment", "--comment", self.comment, "-j", "DROP"]
            self.command("-I", chain, position, *rule)
            self.bridge_rules.append((chain, rule))

    def close(self):
        # Exact specs only. Unexpected foreign additions prevent chain deletion.
        for chain, rule in self.bridge_rules[::-1]:
            self.command("-C", chain, *rule)
            self.command("-D", chain, *rule)
        self.bridge_rules.clear()
        for rule in self.installed_jumps[::-1]:
            self.command("-C", "DOCKER-USER", *rule)
            self.command("-D", "DOCKER-USER", *rule)
        self.installed_jumps.clear()
        for rule in self.installed_rules[::-1]:
            self.command("-C", self.chain, *rule)
            self.command("-D", self.chain, *rule)
        self.installed_rules.clear()
        if self.created:
            self.command("-X", self.chain)
            self.created = False
