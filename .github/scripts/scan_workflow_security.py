"""Keep strict Zizmor checks, with byte-pinned trusted control-plane workflows.

The only exception is dangerous-triggers for reviewed, checkout-free
authorization and merge control planes. Workflow changes invalidate the exception.
No repository ignore comments/configuration can suppress any other finding.
"""

import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys

APPROVAL_WORKFLOW = ".github/workflows/approve-pr-ci.yml"
APPROVAL_SHA256 = "b03e8bd64b173868e454cf5ae25b2d7352c0b5d46d64e74fdca523fe8641a411"

MERGE_WORKFLOW = ".github/workflows/auto-merge-prs.yml"
MERGE_SHA256 = "0b2581f5203c02cfb44d8aa5248d4b558f924d15de71e04598d8bebd1191b5fa"
TRUSTED_WORKFLOWS = {APPROVAL_WORKFLOW: APPROVAL_SHA256, MERGE_WORKFLOW: MERGE_SHA256}


def verify_approval(root=Path(".")):
    for workflow, fingerprint in TRUSTED_WORKFLOWS.items():
        path = root / workflow
        if not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError("Control-plane workflow must be a regular file")
        if hashlib.sha256(path.read_bytes()).hexdigest() != fingerprint:
            raise ValueError("Control-plane workflow changed: review its trust boundary and update the fingerprint")


def blocking_findings(report):
    if not isinstance(report, list):
        raise ValueError("Zizmor returned an invalid report")
    blocking = []
    for finding in report:
        if not isinstance(finding, dict) or not isinstance(finding.get("ident"), str):
            raise ValueError("Malformed Zizmor finding")
        locations = finding.get("locations")
        if not isinstance(locations, list) or not locations:
            raise ValueError("Zizmor finding has no location")
        paths = [location.get("symbolic", {}).get("key", {}).get("Local", {}).get("verbatim_path")
                 for location in locations]
        if (finding["ident"] == "dangerous-triggers" and not finding.get("ignored")
                and all(path in TRUSTED_WORKFLOWS for path in paths)):
            continue
        blocking.append(finding)
    return blocking


def main():
    verify_approval()
    result = subprocess.run([
        "zizmor", "--offline", "--no-config", "--no-ignores", "--strict-collection",
        "--min-severity", "medium", "--format", "json", "--no-exit-codes", ".github/workflows",
    ], capture_output=True, text=True, check=False)
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        raise ValueError("Zizmor could not complete the strict workflow scan")
    findings = blocking_findings(json.loads(result.stdout))
    for finding in findings:
        print(f"::error::{finding['ident']}: {finding.get('desc', 'workflow security finding')}")
    if findings:
        return 1
    print("Strict workflow scan passed; only fingerprinted trusted control-plane triggers are permitted.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
