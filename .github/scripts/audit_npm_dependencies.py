"""Audit locked npm dependencies, verifying advisory withdrawals with GitHub.

npm can retain a withdrawn advisory after GitHub has corrected its source record.
Only a confirmed withdrawal removes that advisory and its transitive findings.
Active advisories, malformed reports, and verification failures remain blocking.
"""

import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path


SEVERITIES = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
ADVISORY_URL = re.compile(r"https://github\.com/advisories/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})")


class AuditError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def github_advisory(ghsa):
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hyperion-locked-dependency-audit",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request("https://api.github.com/advisories/" + ghsa, headers=headers)
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(3):
        try:
            with opener.open(request, timeout=20) as response:
                return json.load(response)
        except (OSError, ValueError):
            if attempt == 2:
                raise AuditError("Could not verify canonical advisory " + ghsa) from None
            time.sleep(attempt + 1)


def evaluate(report, fetch=github_advisory):
    if not isinstance(report, dict) or report.get("error"):
        raise AuditError("npm did not return a successful audit report")
    vulnerabilities = report.get("vulnerabilities")
    if not isinstance(vulnerabilities, dict):
        raise AuditError("npm audit report has no vulnerability mapping")
    canonical = {}
    withdrawn = set()
    active = {}
    for name, node in vulnerabilities.items():
        if not isinstance(node, dict) or node.get("severity") not in SEVERITIES:
            raise AuditError("Invalid vulnerability entry for " + name)
        via = node.get("via")
        if not isinstance(via, list) or not via:
            raise AuditError("Missing advisory evidence for " + name)
        for advisory in via:
            if isinstance(advisory, str):
                if advisory not in vulnerabilities:
                    raise AuditError("Missing transitive advisory entry: " + advisory)
                continue
            if not isinstance(advisory, dict) or advisory.get("severity") not in SEVERITIES:
                raise AuditError("Invalid advisory evidence for " + name)
            url = advisory.get("url")
            match = ADVISORY_URL.fullmatch(url) if isinstance(url, str) else None
            if not match:
                raise AuditError("Unverifiable advisory URL for " + name)
            ghsa = match[1]
            if ghsa not in canonical:
                record = fetch(ghsa)
                if not isinstance(record, dict) or record.get("ghsa_id") != ghsa:
                    raise AuditError("Canonical advisory identity mismatch: " + ghsa)
                if "withdrawn_at" not in record or record.get("severity") not in SEVERITIES:
                    raise AuditError("Incomplete canonical advisory: " + ghsa)
                date = record["withdrawn_at"]
                if date is not None:
                    try:
                        when = datetime.datetime.fromisoformat(date.replace("Z", "+00:00"))
                        if when.tzinfo is None or when > datetime.datetime.now(datetime.timezone.utc):
                            raise ValueError("Invalid withdrawal date")
                    except (AttributeError, TypeError, ValueError):
                        raise AuditError("Invalid withdrawal evidence: " + ghsa) from None
                    withdrawn.add(ghsa)
                canonical[ghsa] = record
            if ghsa not in withdrawn:
                severity = max(SEVERITIES[advisory["severity"]], SEVERITIES[canonical[ghsa]["severity"]])
                active[ghsa] = max(active.get(ghsa, 0), severity)

    if vulnerabilities and not canonical:
        raise AuditError("Vulnerability report contains no verifiable advisory evidence")

    def has_canonical_evidence(name, seen):
        if name in seen:
            return False
        seen = seen | {name}
        return any(
            not isinstance(via, str) or has_canonical_evidence(via, seen)
            for via in vulnerabilities[name]["via"]
        )

    for name in vulnerabilities:
        if not has_canonical_evidence(name, set()):
            raise AuditError("No canonical advisory evidence reachable for " + name)

    def has_active_evidence(name, seen):
        if name in seen:
            return False
        seen = seen | {name}
        for via in vulnerabilities[name]["via"]:
            if isinstance(via, str):
                if has_active_evidence(via, seen):
                    return True
            elif ADVISORY_URL.fullmatch(via["url"])[1] not in withdrawn:
                return True
        return False

    affected = {
        name: node["severity"]
        for name, node in vulnerabilities.items()
        if has_active_evidence(name, set())
    }
    severity = max([*active.values(), *(SEVERITIES[value] for value in affected.values())], default=-1)
    return {"active": active, "affected": affected, "withdrawn": sorted(withdrawn), "severity": severity}


def locked_packages(lock):
    if not isinstance(lock, dict) or lock.get("lockfileVersion") not in (2, 3):
        raise AuditError("Unsupported or malformed npm lockfile")
    nodes = lock.get("packages")
    if not isinstance(nodes, dict) or "" not in nodes:
        raise AuditError("npm lockfile has no package inventory")
    packages = {}
    for path, node in nodes.items():
        if not isinstance(node, dict):
            raise AuditError("Malformed locked package entry")
        if not path or node.get("link") is True:
            continue
        name = node.get("name") or path.rsplit("node_modules/", 1)[-1]
        version = node.get("version")
        if not isinstance(name, str) or not re.fullmatch(r"(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+", name):
            raise AuditError("Invalid locked package name")
        if not isinstance(version, str) or not version or len(version) > 256:
            raise AuditError("Missing locked version for " + name)
        packages.setdefault(name, set()).add(version)
    return {name: sorted(versions) for name, versions in packages.items()}


def npm_advisories(packages):
    # This is npm's documented Bulk Advisory endpoint. Ask about every locked
    # version, including dev and optional dependencies, without running npm's
    # separate fix-resolution machinery or any contributed package scripts.
    request = urllib.request.Request(
        "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
        data=json.dumps(packages).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "hyperion-locked-dependency-audit"},
        method="POST",
    )
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(3):
        try:
            with opener.open(request, timeout=30) as response:
                return json.load(response)
        except (OSError, ValueError):
            if attempt == 2:
                raise AuditError("Could not obtain npm's locked dependency advisories") from None
            time.sleep(attempt + 1)


def bulk_report(packages, advisories):
    if not isinstance(advisories, dict):
        raise AuditError("npm returned an invalid Bulk Advisory report")
    vulnerabilities = {}
    for name, evidence in advisories.items():
        if name not in packages or not isinstance(evidence, list) or not evidence:
            raise AuditError("Unexpected npm advisory package or missing evidence")
        if any(not isinstance(item, dict) or item.get("name", name) != name or item.get("severity") not in SEVERITIES for item in evidence):
            raise AuditError("Invalid npm advisory evidence for " + name)
        severity = max((item["severity"] for item in evidence), key=SEVERITIES.get)
        vulnerabilities[name] = {"severity": severity, "via": evidence}
    return {"vulnerabilities": vulnerabilities}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", default=".")
    parser.add_argument("--audit-level", choices=SEVERITIES, default="high")
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if not (directory / "package-lock.json").is_file():
        raise AuditError("No package-lock.json in " + str(directory))
    try:
        lock = json.loads((directory / "package-lock.json").read_text())
    except ValueError:
        raise AuditError("Invalid npm lockfile JSON") from None
    packages = locked_packages(lock)
    report = bulk_report(packages, npm_advisories(packages))
    print(f"Checked {sum(len(versions) for versions in packages.values())} locked package versions")
    evaluation = evaluate(report)
    for ghsa in evaluation["withdrawn"]:
        print("Verified withdrawn advisory: https://github.com/advisories/" + ghsa)
    for ghsa, severity in sorted(evaluation["active"].items()):
        label = next(name for name, value in SEVERITIES.items() if value == severity)
        print(label + ": https://github.com/advisories/" + ghsa)
    print(f"Active advisories: {len(evaluation['active'])}; affected packages: {len(evaluation['affected'])}")
    return int(evaluation["severity"] >= SEVERITIES[args.audit_level])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AuditError, OSError) as error:
        print("Dependency audit failed: " + str(error), file=sys.stderr)
        sys.exit(1)
