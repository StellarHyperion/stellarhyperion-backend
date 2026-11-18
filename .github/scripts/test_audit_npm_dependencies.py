import copy
import unittest

from audit_npm_dependencies import AuditError, bulk_report, evaluate, locked_packages


ID = "GHSA-fc5q-39xc-vjpf"
OTHER = "GHSA-g3hv-75wg-m249"


def advisory(ghsa=ID, severity="high"):
    return {"url": "https://github.com/advisories/" + ghsa, "severity": severity}


def record(ghsa=ID, withdrawn=None, severity="high"):
    return {"ghsa_id": ghsa, "withdrawn_at": withdrawn, "severity": severity}


def report():
    return {"vulnerabilities": {
        "picomatch": {"severity": "high", "via": [advisory()]},
        "tinyglobby": {"severity": "high", "via": ["picomatch"]},
        "vite": {"severity": "high", "via": ["tinyglobby"]},
    }}


class AuditTests(unittest.TestCase):
    def test_confirmed_withdrawal_removes_only_its_transitive_findings(self):
        result = evaluate(report(), lambda ghsa: record(ghsa, "2026-11-18T15:38:56Z"))
        self.assertEqual(result["withdrawn"], [ID])
        self.assertEqual(result["affected"], {})
        self.assertEqual(result["active"], {})
        self.assertLess(result["severity"], 0)

    def test_active_high_advisory_and_parents_remain_blocking(self):
        result = evaluate(report(), lambda ghsa: record(ghsa))
        self.assertEqual(result["severity"], 3)
        self.assertEqual(set(result["affected"]), {"picomatch", "tinyglobby", "vite"})

    def test_mixed_active_and_withdrawn_findings_keep_shared_parent(self):
        data = report()
        data["vulnerabilities"]["minimatch"] = {"severity": "moderate", "via": [advisory(OTHER, "moderate")]}
        data["vulnerabilities"]["vite"]["via"].append("minimatch")
        result = evaluate(data, lambda ghsa: record(ghsa, "2026-11-18T15:38:56Z" if ghsa == ID else None))
        self.assertEqual(set(result["affected"]), {"minimatch", "vite"})
        self.assertIn(OTHER, result["active"])
        self.assertGreaterEqual(result["severity"], 3)

    def test_canonical_critical_severity_cannot_be_downgraded_by_npm(self):
        result = evaluate(report(), lambda ghsa: record(ghsa, severity="critical"))
        self.assertEqual(result["severity"], 4)

    def test_api_failure_never_exempts_a_finding(self):
        def fail(_ghsa):
            raise AuditError("API unavailable")
        with self.assertRaises(AuditError):
            evaluate(report(), fail)

    def test_identity_mismatch_is_blocking(self):
        with self.assertRaises(AuditError):
            evaluate(report(), lambda _ghsa: record(OTHER, "2026-11-18T15:38:56Z"))

    def test_missing_or_invalid_withdrawal_evidence_is_blocking(self):
        for date in ["invalid", "2999-01-01T00:00:00Z", "2026-01-01", 123, "2026-11-18T15:38:56"]:
            with self.subTest(date=date), self.assertRaises(AuditError):
                evaluate(report(), lambda ghsa: record(ghsa, date))
        with self.assertRaises(AuditError):
            evaluate(report(), lambda ghsa: {"ghsa_id": ghsa, "severity": "high"})

    def test_untrusted_url_never_receives_an_api_lookup(self):
        for url in ["https://github.com.evil/advisories/" + ID, "https://github.com/advisories/" + ID + "?redirect=evil", "http://github.com/advisories/" + ID]:
            data = report()
            data["vulnerabilities"]["picomatch"]["via"][0]["url"] = url
            with self.subTest(url=url), self.assertRaises(AuditError):
                evaluate(data, lambda _ghsa: self.fail("Unexpected fetch"))

    def test_malformed_or_incomplete_npm_reports_fail_closed(self):
        for data in [{}, {"error": {"code": "ENOAUDIT"}}, {"vulnerabilities": []}, {"vulnerabilities": {"x": {"severity": "high", "via": []}}}, {"vulnerabilities": {"x": {"severity": "high", "via": ["missing"]}}}]:
            with self.subTest(data=data), self.assertRaises(AuditError):
                evaluate(data)

    def test_clean_report_needs_no_api_access(self):
        result = evaluate({"vulnerabilities": {}}, lambda _ghsa: self.fail("Unexpected fetch"))
        self.assertEqual(result["affected"], {})

    def test_cycle_with_a_real_active_advisory_still_blocks(self):
        data = report()
        data["vulnerabilities"]["picomatch"]["via"].append("vite")
        self.assertEqual(evaluate(data, lambda ghsa: record(ghsa))["severity"], 3)

    def test_orphan_cycle_fails_even_alongside_verified_withdrawal(self):
        data = report()
        data["vulnerabilities"].update({
            "orphan1": {"severity": "high", "via": ["orphan2"]},
            "orphan2": {"severity": "high", "via": ["orphan1"]},
        })
        with self.assertRaises(AuditError):
            evaluate(data, lambda ghsa: record(ghsa, "2026-11-18T15:38:56Z"))

    def test_cycle_with_only_verified_withdrawal_can_clear(self):
        data = report()
        data["vulnerabilities"]["picomatch"]["via"].append("vite")
        result = evaluate(data, lambda ghsa: record(ghsa, "2026-11-18T15:38:56Z"))
        self.assertEqual(result["affected"], {})

    def test_lock_inventory_includes_nested_dev_optional_and_alias_versions(self):
        data = {"lockfileVersion": 3, "packages": {
            "": {"name": "app", "version": "1.0.0"},
            "node_modules/picomatch": {"version": "4.0.7", "dev": True},
            "node_modules/vite/node_modules/picomatch": {"version": "2.3.2", "optional": True},
            "node_modules/@scope/pkg": {"version": "1.2.3"},
            "node_modules/alias": {"name": "actual-package", "version": "2.0.0"},
            "node_modules/local-link": {"link": True, "resolved": "packages/local"},
            "packages/local": {"name": "local-link", "version": "1.0.0"},
        }}
        self.assertEqual(locked_packages(data), {
            "picomatch": ["2.3.2", "4.0.7"], "@scope/pkg": ["1.2.3"],
            "actual-package": ["2.0.0"], "local-link": ["1.0.0"],
        })

    def test_malformed_lock_inventory_fails_closed(self):
        for data in [{}, {"lockfileVersion": 3, "packages": {}},
                     {"lockfileVersion": 3, "packages": {"": {}, "node_modules/x": {}}}]:
            with self.subTest(data=data), self.assertRaises(AuditError):
                locked_packages(data)

    def test_bulk_advisories_feed_canonical_verification(self):
        evidence = advisory()
        data = bulk_report({"picomatch": ["4.0.7"]}, {"picomatch": [evidence]})
        self.assertEqual(evaluate(data, lambda ghsa: record(ghsa))["severity"], 3)
        self.assertEqual(evaluate(data, lambda ghsa: record(ghsa, "2026-11-18T15:38:56Z"))["active"], {})

    def test_bulk_errors_and_unexpected_evidence_fail_closed(self):
        for data in [[], {"error": "unavailable"}, {"unexpected": [advisory()]},
                     {"picomatch": []}, {"picomatch": [{**advisory(), "name": "other"}]}]:
            with self.subTest(data=data), self.assertRaises(AuditError):
                bulk_report({"picomatch": ["4.0.7"]}, data)

    def test_each_canonical_advisory_is_fetched_once(self):
        calls = []
        data = copy.deepcopy(report())
        data["vulnerabilities"]["vite"]["via"].append(advisory())
        def fetch(ghsa):
            calls.append(ghsa)
            return record(ghsa)
        evaluate(data, fetch)
        self.assertEqual(calls, [ID])


if __name__ == "__main__":
    unittest.main()
