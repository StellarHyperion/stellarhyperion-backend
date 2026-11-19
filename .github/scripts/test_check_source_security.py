"""Exercise severity gating and failed/malformed source analyses."""

import copy
import tempfile
import unittest

from check_source_security import findings, main


def report(severity="8.1"):
    return {"version": "2.1.0", "runs": [{
        "tool": {"driver": {"rules": [{"id": "js/test-security", "properties": {"security-severity": severity}}]}},
        "results": [{"ruleId": "js/test-security"}],
    }]}


class SourceSecurityTests(unittest.TestCase):
    def test_high_and_critical_findings_block(self):
        for severity in ["7.0", "8.1", "9.8"]:
            self.assertEqual(findings(report(severity)), [("js/test-security", str(float(severity)))])

    def test_lower_severity_findings_are_retained_without_blocking(self):
        self.assertEqual(findings(report("6.9")), [])

    def test_clean_analysis_passes(self):
        data = report()
        data["runs"][0]["results"] = []
        self.assertEqual(findings(data), [])

    def test_extension_rule_metadata_is_used(self):
        data = report()
        run = data["runs"][0]
        rules = run["tool"]["driver"].pop("rules")
        run["tool"]["extensions"] = [{"rules": rules}]
        self.assertTrue(findings(data))

    def test_failed_analysis_is_not_clean(self):
        data = report()
        data["runs"][0]["invocations"] = [{"executionSuccessful": False}]
        with self.assertRaises(ValueError):
            findings(data)

    def test_missing_or_invalid_metadata_fails_closed(self):
        for severity in ["nan", "inf", "11", "-1", "invalid"]:
            with self.subTest(severity=severity), self.assertRaises(ValueError):
                findings(report(severity))
        data = report()
        data["runs"][0]["tool"]["driver"]["rules"] = []
        with self.assertRaises(ValueError):
            findings(data)
        for data in [{}, {"version": "2.1.0", "runs": []}]:
            with self.assertRaises(ValueError):
                findings(data)

    def test_missing_analysis_artifact_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            main(directory)


if __name__ == "__main__":
    unittest.main()
