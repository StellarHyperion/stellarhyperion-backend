"""Regression tests for the narrow privileged-trigger exception."""

import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import scan_workflow_security as scanner


def finding(ident="dangerous-triggers", path=scanner.APPROVAL_WORKFLOW):
    return {"ident": ident, "ignored": False,
            "locations": [{"symbolic": {"key": {"Local": {"verbatim_path": path}}}}]}


class WorkflowSecurityTests(unittest.TestCase):
    def test_actual_reviewed_workflow_matches_fingerprint(self):
        scanner.verify_approval(Path(__file__).resolve().parents[2])

    def test_edits_cannot_keep_privileged_trigger_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / scanner.APPROVAL_WORKFLOW
            path.parent.mkdir(parents=True)
            path.write_text("on: pull_request_target\n")
            with self.assertRaises(ValueError):
                scanner.verify_approval(root)

    def test_symlink_cannot_supply_the_approved_workflow(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / scanner.APPROVAL_WORKFLOW
            path.parent.mkdir(parents=True)
            path.symlink_to(Path(__file__).resolve().parents[2] / scanner.APPROVAL_WORKFLOW)
            with self.assertRaises(ValueError):
                scanner.verify_approval(root)

    def test_only_trigger_finding_in_the_reviewed_workflow_is_permitted(self):
        trusted = finding()
        other_trigger = finding(path=".github/workflows/untrusted.yml")
        other_audit = finding(ident="template-injection")
        self.assertEqual(scanner.blocking_findings([trusted, other_trigger, other_audit]),
                         [other_trigger, other_audit])

    def test_mixed_locations_and_ignored_findings_cannot_take_exception(self):
        mixed = finding()
        mixed["locations"].extend(finding(path=".github/workflows/ci.yml")["locations"])
        suppressed = finding()
        suppressed["ignored"] = True
        self.assertEqual(scanner.blocking_findings([mixed, suppressed]), [mixed, suppressed])

    def test_malformed_or_unlocated_report_fails_closed(self):
        for report in [{}, [None], [{"ident": "dangerous-triggers"}],
                       [{"ident": "dangerous-triggers", "locations": []}]]:
            with self.subTest(report=report), self.assertRaises(ValueError):
                scanner.blocking_findings(report)

    def test_tool_failure_cannot_be_reported_as_success(self):
        with patch.object(scanner, "verify_approval"), patch.object(scanner.subprocess, "run") as run:
            run.return_value.returncode = 1
            run.return_value.stderr = "scanner unavailable"
            with self.assertRaises(ValueError):
                scanner.main()


if __name__ == "__main__":
    unittest.main()
