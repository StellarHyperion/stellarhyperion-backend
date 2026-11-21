"""Regression tests for automated merge admission, races and contributor feedback."""

import base64
import copy
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import urllib.error

import auto_merge_prs as merger

HEAD, BASE = "a" * 40, "b" * 40
REPO = "StellarHyperion/example"
PREFIX = f"repos/{REPO}/"


def pr():
    return {"number": 1, "state": "open", "draft": False, "title": "Fix #42",
            "body": "## Summary\nFix #42 and add regression coverage.", "author_association": "NONE",
            "user": {"login": "alice", "type": "User"}, "mergeable": True,
            "mergeable_state": "clean", "changed_files": 1,
            "head": {"sha": HEAD, "ref": "fix", "repo": {"id": 2, "full_name": "alice/example"}},
            "base": {"sha": BASE, "ref": "main", "repo": {"id": 1, "full_name": REPO}}}


def run():
    return {"id": 12, "run_attempt": 2, "event": "pull_request", "path": merger.CI_PATH,
            "head_sha": HEAD, "head_branch": "fix", "head_repository": pr()["head"]["repo"],
            "repository": {"full_name": REPO}, "status": "completed", "conclusion": "success"}


class FakeGitHub:
    def __init__(self):
        self.repository, self.policy_ref = REPO, BASE
        self.pr, self.run = pr(), run()
        self.jobs = [{"name": "gate", "head_sha": HEAD, "status": "completed", "conclusion": "success"}]
        self.files = [{"filename": "src/fix.py"}]
        self.issue = {"title": "Fix bug", "body": "Acceptance criteria", "state": "open",
                      "assignees": [{"login": "alice"}]}
        self.refs = set()
        self.comments, self.reviews, self.statuses, self.checks = [], [], [], []
        self.resolved, self.branch = True, BASE
        self.writes, self.reads = [], []

    def linked_issues(self, number):
        return self.refs

    def request(self, path, method="GET", data=None):
        self.reads.append(path)
        if method in {"PUT", "PATCH"} or method == "POST" and path != "graphql":
            self.writes.append((path, method, data))
            if path.endswith("/merge"):
                return {"merged": True}
            return {"id": 1}
        if path == PREFIX + "pulls/1":
            return copy.deepcopy(self.pr)
        if path == PREFIX + "actions/runs/12":
            return copy.deepcopy(self.run)
        if "/actions/workflows/ci.yml/runs?" in path:
            return {"workflow_runs": [copy.deepcopy(self.run)]}
        if "/attempts/2/jobs?" in path:
            return {"jobs": copy.deepcopy(self.jobs)}
        if "/contents/" in path:
            return {"type": "file", "encoding": "base64", "content": base64.b64encode(b"## Summary\nDescribe change").decode()}
        if "/issues/" in path:
            return copy.deepcopy(self.issue)
        if "/compare/" in path:
            return {"merge_base_commit": {"sha": self.branch}, "status": "ahead"}
        if "/check-runs?" in path:
            return {"check_runs": copy.deepcopy(self.checks)}
        if "/git/ref/heads/" in path:
            return {"object": {"sha": self.branch}}
        if path == "graphql":
            return {"data": {"repository": {"pullRequest": {"reviewThreads": {
                "nodes": [{"isResolved": self.resolved}],
                "pageInfo": {"hasNextPage": False, "endCursor": None}}}}}}
        raise AssertionError(path)

    def pages(self, path):
        if path.endswith("/files"):
            return iter(copy.deepcopy(self.files))
        if path.endswith("/reviews"):
            return iter(copy.deepcopy(self.reviews))
        if path.endswith("/comments"):
            return iter(copy.deepcopy(self.comments))
        if path.endswith("/statuses"):
            return iter(copy.deepcopy(self.statuses))
        raise AssertionError(path)


class AutoMergeTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeGitHub()
        self.policy = Mock()
        self.policy.decision.return_value = (True, "assigned")
        self.bot = merger.AutoMerge(self.api, self.policy, "main")

    def assert_wait(self, text):
        result = self.bot.process(1)
        self.assertIn(text, result)
        self.assertFalse(any(path.endswith("/merge") for path, _, _ in self.api.writes))
        self.assertTrue(any(path.endswith("/comments") for path, _, _ in self.api.writes))

    def test_valid_pr_merges_with_expected_head_and_no_coauthor_trailers(self):
        self.assertTrue(self.bot.process(1).startswith("MERGED"))
        self.assertEqual(len(self.api.writes), 1)
        data = self.api.writes[0][2]
        self.assertEqual(data["sha"], HEAD)
        self.assertEqual(data["merge_method"], "squash")
        self.assertNotIn("co-authored-by", str(data).lower())
        self.assertEqual(self.policy.decision.call_count, 2)

    def test_dry_run_performs_no_remote_writes(self):
        self.assertTrue(self.bot.process(1, True).startswith("WOULD MERGE"))
        self.api.jobs[0]["conclusion"] = "failure"
        self.bot.process(1, True)
        self.assertEqual(self.api.writes, [])

    def test_assignment_closure_policy_is_not_bypassed(self):
        self.policy.decision.return_value = (False, "author is not assigned to example#42")
        self.assert_wait("not assigned")

    def test_no_issue_and_pr_only_reference_cannot_merge(self):
        for body, issue in [("## Summary\nNo issue linked.", self.api.issue),
                            (pr()["body"], {**self.api.issue, "pull_request": {}})]:
            with self.subTest(body=body):
                self.api.pr["title"] = "Fix bug"
                self.api.pr["body"] = body
                self.api.issue = issue
                self.assert_wait("real StellarHyperion issue")

    def test_current_description_is_validated_even_after_green_ci(self):
        self.api.pr["body"] = "Closes #42"
        self.assert_wait("Include exactly one")

    def test_all_ci_jobs_and_latest_attempt_must_succeed(self):
        for conclusion in ["failure", "skipped", "neutral", "cancelled", None]:
            with self.subTest(conclusion=conclusion):
                self.api.jobs[0]["conclusion"] = conclusion
                self.assert_wait("gate")
        self.assertTrue(any("attempts/2/jobs" in path for path in self.api.reads))

    def test_missing_gate_cannot_be_replaced_with_green_workflow(self):
        self.api.jobs = []
        self.assert_wait("successful gate")

    def test_ci_provenance_rejects_other_revision_repo_event_or_workflow(self):
        changes = [{"head_sha": BASE}, {"event": "push"}, {"path": ".github/workflows/fake.yml"},
                   {"head_branch": "other"}, {"repository": {"full_name": "attacker/example"}},
                   {"head_repository": {"id": 3, "full_name": "alice/example"}}]
        for change in changes:
            with self.subTest(change=change):
                self.assertFalse(merger.run_matches(pr(), {**run(), **change}, REPO))

    def test_same_repository_pr_ci_is_supported(self):
        candidate, workflow = pr(), run()
        candidate["head"]["repo"] = candidate["base"]["repo"]
        workflow["head_repository"] = candidate["base"]["repo"]
        self.assertTrue(merger.run_matches(candidate, workflow, REPO))

    def test_draft_conflict_and_unknown_mergeability_block(self):
        for change, reason in [({"draft": True}, "ready for review"),
                               ({"mergeable": False}, "conflicts"),
                               ({"mergeable": None}, "calculating"),
                               ({"mergeable_state": "behind"}, "Update your branch")]:
            with self.subTest(change=change):
                self.api.pr = {**pr(), **change}
                self.assert_wait(reason)

    def test_nonancestor_base_blocks_even_if_github_says_clean(self):
        self.api.branch = "c" * 40
        self.assert_wait("Update your branch")

    def test_changed_security_policy_and_renames_require_maintainer(self):
        for item in [{"filename": ".github/workflows/ci.yml"},
                     {"filename": "src/safe.py", "previous_filename": ".github/scripts/check.py"},
                     {"filename": "nested/AGENTS.md"}, {"filename": "CODEOWNERS"}]:
            with self.subTest(item=item):
                self.api.files = [item]
                self.assert_wait("Maintainer merge required")

    def test_incomplete_file_listing_is_an_error_not_an_approval(self):
        self.api.pr["changed_files"] = 2
        with self.assertRaises(ValueError):
            self.bot.process(1)
        self.assertEqual(self.api.writes, [])

    def test_unresolved_conversation_or_requested_changes_blocks(self):
        self.api.resolved = False
        self.assert_wait("Resolve every")
        self.api.resolved = True
        self.api.reviews = [{"state": "CHANGES_REQUESTED", "user": {"login": "owner"}}]
        self.assert_wait("requested changes")

    def test_latest_approval_supersedes_old_change_request(self):
        self.api.reviews = [{"state": value, "user": {"login": "owner"}}
                            for value in ["CHANGES_REQUESTED", "COMMENTED", "APPROVED"]]
        self.assertTrue(self.bot.process(1).startswith("MERGED"))

    def test_pending_external_check_and_failed_status_block(self):
        self.api.checks = [{"name": "external", "status": "in_progress", "conclusion": None}]
        self.assert_wait("external")
        self.api.checks = []
        self.api.statuses = [{"context": "deploy", "state": "failure"}]
        self.assert_wait("deploy")

    def test_new_status_supersedes_old_failure(self):
        self.api.statuses = [{"context": "deploy", "state": state} for state in ["success", "failure"]]
        self.assertTrue(self.bot.process(1).startswith("MERGED"))

    def test_issue_or_ci_change_between_inspections_prevents_merge(self):
        original = self.bot.inspect
        count = 0
        def changed(candidate):
            nonlocal count
            count += 1
            if count == 2:
                self.api.issue["body"] = "New acceptance criteria"
            return original(candidate)
        with patch.object(self.bot, "inspect", side_effect=changed):
            self.assert_wait("changed during verification")

    def test_assignment_revocation_during_verification_blocks_merge(self):
        self.policy.decision.side_effect = [(True, "assigned"), (False, "assignment revoked")]
        self.assert_wait("assignment revoked")

    def test_final_head_or_base_change_prevents_merge(self):
        original = self.api.request
        reads = 0
        def changed(path, method="GET", data=None):
            nonlocal reads
            if path == PREFIX + "pulls/1":
                reads += 1
                if reads == 3:
                    self.api.pr["head"]["sha"] = "c" * 40
            return original(path, method, data)
        with patch.object(self.api, "request", side_effect=changed):
            self.assert_wait("just before merging")

    def test_merge_conflict_api_response_becomes_actionable_comment(self):
        original = self.api.request
        def conflict(path, method="GET", data=None):
            if path.endswith("/merge"):
                raise urllib.error.HTTPError("https://api.github.com", 409, "head changed", {}, None)
            return original(path, method, data)
        with patch.object(self.api, "request", side_effect=conflict):
            self.assert_wait("HTTP 409")

    def test_feedback_updates_only_bot_owned_comment_without_spam(self):
        self.bot.comment(1, ["Fix CI", "Fix CI"])
        body = self.api.writes[-1][2]["body"]
        self.assertEqual(body.count("Fix CI"), 1)
        self.api.comments = [{"id": 7, "body": body, "user": {"login": merger.BOT_LOGIN, "type": "Bot"}}]
        self.api.writes = []
        self.bot.comment(1, ["Fix CI"])
        self.assertEqual(self.api.writes, [])
        self.bot.comment(1, ["Fix tests"])
        self.assertEqual(self.api.writes[-1][0], PREFIX + "issues/comments/7")
        self.api.comments[0]["user"]["login"] = "attacker"
        self.bot.comment(1, ["Fix tests"])
        self.assertEqual(self.api.writes[-1][1], "POST")

    def test_closed_pr_is_never_commented_or_merged(self):
        self.api.pr["state"] = "closed"
        self.bot.comment(1, ["fix"])
        self.assertTrue(self.bot.process(1).startswith("SKIP"))
        self.assertEqual(self.api.writes, [])

    def test_untrusted_feedback_cannot_inject_mentions_or_html(self):
        value = merger.safe_text("@everyone <script>alert(1)</script> [click](https://evil)\n# title")
        self.assertNotIn("@everyone", value)
        self.assertNotIn("<script>", value)
        self.assertNotIn("\n", value)
        self.assertIn("\\[click", value)

    def test_privileged_workflow_never_checks_out_or_downloads_artifacts(self):
        path = Path(__file__).resolve().parents[1] / "workflows/auto-merge-prs.yml"
        source = path.read_text()
        for forbidden in ["actions/checkout", "actions/download-artifact", "pull_request.head", "secrets."]:
            self.assertNotIn(forbidden, source)
        self.assertIn("github.workflow_sha", source)


if __name__ == "__main__":
    unittest.main()
