"""Exercise the trusted PR safety policy with inert GitHub API fixtures."""

import base64
import copy
import json
import os
import unittest
from unittest.mock import patch

from pr_safety import CONTEXT, MAX_FILES, STATUS_AUTHOR, Safety, added_lines, findings

BASE, HEAD, BLOB = "a" * 40, "b" * 40, "c" * 40
REPO = "StellarHyperion/example"
ENDPOINT = f"repos/{REPO}/pulls/42"


def change(path, line="example", **overrides):
    return {"filename": path, "status": "modified", "sha": BLOB, "additions": 1, "deletions": 0,
            "patch": "@@ -0,0 +1 @@\n+" + line, **overrides}


class GitHub:
    repository = REPO

    def __init__(self):
        self.pr = {"state": "open", "base": {"sha": BASE, "ref": "dev", "repo": {"full_name": REPO}},
                   "head": {"sha": HEAD}, "changed_files": 1}
        self.files = [change("src/example.py")]
        self.manifests = {}
        self.writes = []
        self.statuses = []
        self.available = True

    def comparison(self):
        return {"base_commit": {"sha": BASE}, "merge_base_commit": {"sha": BASE}, "files": self.files}

    def request(self, path, method="GET", data=None):
        if path == ENDPOINT:
            return copy.deepcopy(self.pr)
        if path == f"repos/{REPO}/compare/{BASE}...{HEAD}?per_page=1" and method == "GET":
            if not self.available:
                raise OSError("temporarily unavailable")
            return self.comparison()
        if path == f"repos/{REPO}/statuses/{HEAD}" and method == "POST":
            self.writes.append(data)
            return None
        for (ref, manifest), value in self.manifests.items():
            if path == f"repos/{REPO}/contents/{manifest}?ref={ref}" and method == "GET":
                return {"type": "file", "encoding": "base64", "sha": BLOB,
                        "content": base64.b64encode(json.dumps(value).encode()).decode()}
        raise AssertionError((method, path))

    def pages(self, path):
        if path == f"repos/{REPO}/commits/{HEAD}/statuses":
            return iter(self.statuses)
        raise AssertionError(path)


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.github = GitHub()

    def scan(self, *changes):
        self.github.pr["changed_files"] = len(changes)
        self.github.files = list(changes)
        return findings(self.github, self.github.pr, self.github.comparison())

    def test_clean_source_and_binary_image_pass(self):
        self.assertEqual(self.scan(change("src/example.py", "    return True"),
                                   change("docs/image.png", additions=0, patch=None)), [])

    def test_reported_path_categories_and_hidden_layout(self):
        changes = [change(".gitignore", "regular entry" + " " * 120 + "another entry"),
                   change("evm/init"), change("packages/protocol/init"),
                   change("packages/protocol/eslint.config.mjs"), change(".vscode/tasks.json"),
                   change("example.code-workspace"), change("nested/.npmrc")]
        issues = self.scan(*changes)
        self.assertEqual(len(issues), len(changes))
        for issue, file in zip(issues, changes):
            self.assertTrue(issue.startswith(file["filename"] + ":"))
        self.assertNotIn("another entry", issues[0])

    def test_tabs_control_chars_and_extreme_lines_are_flagged(self):
        for line in ("text" + "\t" * 12 + "more", "text\u202emore", "a" * 4100):
            with self.subTest(line_length=len(line)):
                self.assertIn("wide gap", self.scan(change("src/example.py", line))[0])

    def test_only_added_lines_are_checked_and_hunks_must_be_complete(self):
        patch_text = "@@ -1,2 +1,2 @@\n normal\n-" + " " * 100 + "text\n+new\n\\ No newline at end of file"
        file = change("src/example.py", deletions=1, patch=patch_text)
        self.assertEqual(added_lines(file), ["new"])
        self.assertEqual(self.scan(file), [])
        self.assertIn("no complete", self.scan({**file, "additions": 2})[0])
        self.assertIn("no complete", self.scan({**file, "patch": patch_text.replace("-1,2", "-1,3")})[0])
        self.assertIn("no complete", self.scan({**file, "patch": None})[0])

    def test_opaque_non_asset_and_renamed_autorun_path_fail(self):
        self.assertEqual(len(self.scan(change("src/example.py", additions=0, patch=None),
                                       change("misc/settings.json", status="renamed",
                                              previous_filename=".vscode/tasks.json"))), 2)

    def test_npm_script_changes_fail_but_dependency_changes_pass(self):
        for path in ("evm/package.json", "packages/protocol/package.json"):
            with self.subTest(path=path):
                scripts = {"lint": "lint", "prepare": "prepare"}
                self.github.manifests[(BASE, path)] = {"scripts": scripts, "dependencies": {"example": "1"}}
                self.github.manifests[(HEAD, path)] = {"scripts": scripts, "dependencies": {"example": "2"}}
                self.assertEqual(self.scan(change(path)), [])
                self.github.manifests[(HEAD, path)]["scripts"] = {**scripts, "prepare": "new-prepare"}
                self.assertIn("package scripts changed", self.scan(change(path))[0])
                with self.assertRaises(ValueError):
                    self.scan(change(path, sha="d" * 40))

    def test_diff_cap_count_and_duplicate_paths_fail_closed(self):
        for files, count in (([], 1), ([change("src/example.py")] * 2, 2),
                             ([change(f"src/file-{index}") for index in range(MAX_FILES)], MAX_FILES)):
            with self.subTest(count=count), self.assertRaises(ValueError):
                self.github.pr["changed_files"] = count
                self.github.files = files
                findings(self.github, self.github.pr, self.github.comparison())

    @patch.dict(os.environ, {"GITHUB_RUN_ID": "17"})
    def test_writes_exact_head_verdicts_without_repeating_statuses(self):
        safety = Safety(self.github)
        self.assertEqual(safety.report(self.github.pr, ENDPOINT), ("success", []))
        status = self.github.writes[-1]
        self.assertEqual(status["context"], CONTEXT)
        self.assertEqual(status["target_url"], f"https://github.com/{REPO}/actions/runs/17")
        self.github.statuses = [{**status, "creator": {"login": STATUS_AUTHOR}}]
        safety.report(self.github.pr, ENDPOINT)
        self.assertEqual(len(self.github.writes), 1)
        self.github.files = [change("evm/init")]
        self.assertEqual(safety.report(self.github.pr, ENDPOINT)[0], "failure")
        self.github.available = False
        self.assertEqual(safety.report(self.github.pr, ENDPOINT)[0], "error")
        self.assertEqual([status["state"] for status in self.github.writes], ["success", "failure", "error"])

    def test_head_change_during_scan_skips_status(self):
        previous = copy.deepcopy(self.github.pr)
        self.github.pr["head"]["sha"] = "d" * 40
        self.assertEqual(Safety(self.github).report(previous, ENDPOINT), ("changed", []))
        self.assertEqual(self.github.writes, [])


if __name__ == "__main__":
    unittest.main()
