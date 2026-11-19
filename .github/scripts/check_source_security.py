"""Fail the gate on high/critical CodeQL findings; retain all findings in SARIF."""

import json
import math
from pathlib import Path
import sys


def findings(report):
    if not isinstance(report, dict) or report.get("version") != "2.1.0":
        raise ValueError("Invalid source security SARIF report")
    runs = report.get("runs")
    if not isinstance(runs, list) or not runs:
        raise ValueError("Source security report has no analysis run")
    blocking = []
    for run in runs:
        if any(item.get("executionSuccessful") is False for item in run.get("invocations", [])):
            raise ValueError("Source analysis did not complete successfully")
        rules = run["tool"]["driver"].get("rules", [])
        extensions = run["tool"].get("extensions", [])
        by_id = {rule["id"]: rule for rule in rules}
        for extension in extensions:
            by_id.update({rule["id"]: rule for rule in extension.get("rules", [])})
        results = run.get("results")
        if not isinstance(results, list):
            raise ValueError("Source security analysis has no result list")
        for result in results:
            rule_id = result.get("ruleId") or result.get("rule", {}).get("id")
            if rule_id not in by_id:
                raise ValueError("Source finding references an unknown rule")
            rule = by_id[rule_id]
            severity = rule.get("properties", {}).get("security-severity")
            if severity is None:
                if result.get("level", rule.get("defaultConfiguration", {}).get("level")) == "error":
                    blocking.append((rule_id, "error"))
                continue
            score = float(severity)
            if not math.isfinite(score) or not 0 <= score <= 10:
                raise ValueError("Invalid source security severity")
            if score >= 7:
                blocking.append((rule_id, str(score)))
    return blocking


def main(directory):
    files = sorted(Path(directory).glob("*.sarif"))
    if not files:
        raise ValueError("CodeQL did not produce a SARIF report")
    blocking = []
    for path in files:
        blocking.extend(findings(json.loads(path.read_text())))
    for rule, severity in blocking:
        print(f"::error::Source security finding {rule} (severity {severity}); review the SARIF artifact.")
    print(f"Checked {len(files)} source analysis report(s); {len(blocking)} blocking finding(s).")
    return int(bool(blocking))


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
