"""Regression tests for automated merge admission, races and contributor feedback."""

import base64
import copy
from pathlib import Path
import unittest
import re
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
            "base": {"sha": BASE, "ref": "dev", "repo": {"id": 1, "full_name": REPO}}}


def run():
    return {"id": 12, "run_attempt": 2, "event": "pull_request", "path": merger.CI_PATH,
            "head_sha": HEAD, "head_branch": "fix", "head_repository": pr()["head"]["repo"],
            "repository": {"full_name": REPO}, "status": "completed", "conclusion": "success"}


class FakeGitHub:
    def __init__(self):
        self.repository, self.policy_ref = REPO, BASE
        self.pr, self.run = pr(), run()
        self.jobs = [{"name": merger.CI_GATE, "head_sha": HEAD, "status": "completed", "conclusion": "success"}]
        self.files = [{"filename": "src/fix.py", "status": "added", "additions": 1, "deletions": 0,
                       "patch": "@@ -0,0 +1 @@\n+fixed = True"}]
        self.issue = {"title": "Fix bug", "body": "Acceptance criteria", "state": "open",
                      "state_reason": None,
                      "assignees": [{"login": "alice"}]}
        self.refs = set()
        self.issues = {}
        self.comments, self.reviews, self.statuses, self.checks = [], [], [], []
        self.safety_status = [{"context": "PR safety", "state": "success", "description": f"Passed (base {BASE})",
                               "creator": {"login": "github-actions[bot]"}}]
        self.resolved, self.branch = True, BASE
        self.writes, self.reads = [], []
        self.extra_runs, self.extra_jobs = {}, {}

    def linked_issues(self, number):
        return self.refs

    def request(self, path, method="GET", data=None):
        self.reads.append(path)
        if method in {"PUT", "PATCH"} or method == "POST" and path != "graphql":
            self.writes.append((path, method, data))
            if path.endswith("/merge"):
                self.pr.update(state="closed", merged=True, merged_at="2026-11-24T01:00:00Z", merge_commit_sha=BASE)
                return {"merged": True}
            if "/issues/" in path and method == "PATCH" and "state_reason" in data:
                key = path.rsplit("/", 1)[1]
                issue = self.issues.get(key, self.issue)
                issue.update(data)
                return copy.deepcopy(issue)
            return {"id": 1}
        if path.startswith(PREFIX + "actions/runs/"):
            match = re.fullmatch(re.escape(PREFIX) + r"actions/runs/(\d+)", path)
            if match and int(match[1]) in self.extra_runs:
                return copy.deepcopy(self.extra_runs[int(match[1])])
            match = re.match(re.escape(PREFIX) + r"actions/runs/(\d+)/attempts/(\d+)/jobs\?", path)
            if match and (int(match[1]), int(match[2])) in self.extra_jobs:
                return {"jobs": copy.deepcopy(self.extra_jobs[(int(match[1]), int(match[2]))])}
        if path == PREFIX + "pulls/1":
            return copy.deepcopy(self.pr)
        if path == PREFIX + "actions/runs/12":
            return copy.deepcopy(self.run)
        if "/actions/workflows/dev-ci.yml/runs?" in path:
            return {"workflow_runs": [copy.deepcopy(self.run)]}
        if "/attempts/2/jobs?" in path:
            return {"jobs": copy.deepcopy(self.jobs)}
        if "/contents/" in path:
            return {"type": "file", "encoding": "base64", "content": base64.b64encode(b"## Summary\nDescribe change").decode()}
        if "/issues/" in path:
            return copy.deepcopy(self.issues.get(path.rsplit("/", 1)[1], self.issue))
        if "/compare/" in path:
            return {"base_commit": {"sha": BASE}, "merge_base_commit": {"sha": self.branch},
                    "status": "ahead", "files": copy.deepcopy(self.files)}
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
        if path.endswith("/reviews"):
            return iter(copy.deepcopy(self.reviews))
        if path.endswith("/comments"):
            return iter(copy.deepcopy(self.comments))
        if path.endswith("/statuses"):
            return iter(copy.deepcopy(self.statuses + self.safety_status))
        raise AssertionError(path)


class IssueCompletionTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeGitHub()
        self.api.pr.update(state="closed", merged=True, merged_at="2026-11-24T01:00:00Z", merge_commit_sha=BASE)
        self.bot = merger.IssueCompletion(self.api, "dev")

    def test_only_issues_assigned_to_original_author_are_completed(self):
        self.api.pr["body"] = "Closes #42. Related #43, #44, #45. outside/other#46"
        self.api.refs = {(REPO.lower(), 47)}
        self.api.issues = {
            "43": {**self.api.issue, "assignees": [{"login": "bob"}]},
            "44": {**self.api.issue, "assignees": []},
            "45": {**self.api.issue, "pull_request": {}},
            "47": {**self.api.issue, "assignees": [{"login": "ALICE"}, {"login": "bob"}]}}
        self.assertEqual(self.bot.process(1), "COMPLETED: 2 issue(s)")
        self.assertEqual([path.rsplit("/", 1)[1] for path, _, _ in self.api.writes], ["42", "47"])
        for _, method, data in self.api.writes:
            self.assertEqual(method, "PATCH")
            self.assertEqual(data, {"state": "closed", "state_reason": "completed"})

    def test_incidental_title_body_examples_and_comments_never_close_assigned_issues(self):
        self.api.pr["title"] = "Fix #42"
        self.api.pr["body"] = "Related #42.\n<!-- Closes #43 -->\n```\nCloses #44\n```\nDo not close #45"
        self.assertEqual(self.bot.process(1), "COMPLETED: 0 issue(s)")
        self.assertEqual(self.api.writes, [])

    def test_closing_variants_urls_and_lists_use_exact_issue_targets(self):
        refs = merger.completion_references("Closes #42, #43. Fixes StellarHyperion/other#44. Resolved https://github.com/StellarHyperion/example/issues/45. Related #46", REPO)
        self.assertEqual(refs, {(REPO.lower(), 42), (REPO.lower(), 43), ("stellarhyperion/other", 44), (REPO.lower(), 45)})

    def test_assignment_revoked_after_merge_prevents_issue_completion(self):
        self.api.pr.update(state="open", merged=False, merged_at=None)
        policy = Mock()
        policy.decision.return_value = (True, "assigned")
        request = self.api.request
        def revoke(path, method="GET", data=None):
            result = request(path, method, data)
            if path.endswith("/merge"):
                self.api.issue["assignees"] = []
            return result
        with patch.object(self.api, "request", side_effect=revoke):
            self.assertTrue(merger.AutoMerge(self.api, policy, "dev").process(1).startswith("MERGED"))
        self.assertEqual(len(self.api.writes), 1)
        self.assertTrue(self.api.writes[0][0].endswith("/merge"))

    def test_maintainer_role_does_not_exempt_assignment_requirement(self):
        self.api.pr["author_association"] = "OWNER"
        self.api.issue["assignees"] = [{"login": "bob"}]
        self.assertEqual(self.bot.process(1), "COMPLETED: 0 issue(s)")
        self.assertEqual(self.api.writes, [])

    def test_unmerged_closed_draft_open_and_wrong_base_are_preserved(self):
        for changes in [{"merged": False}, {"state": "open"}, {"merged_at": None},
                        {"base": {**pr()["base"], "ref": "release"}},
                        {"base": {**pr()["base"], "repo": {"full_name": "other/example"}}}]:
            with self.subTest(changes=changes):
                original = copy.deepcopy(self.api.pr)
                self.api.pr.update(changes)
                self.assertTrue(self.bot.process(1).startswith("SKIP"))
                self.assertEqual(self.api.writes, [])
                self.api.pr = original

    def test_missing_or_nonancestor_merge_revision_is_preserved(self):
        self.api.pr["merge_commit_sha"] = None
        with self.assertRaises(ValueError):
            self.bot.process(1)
        self.api.pr["merge_commit_sha"] = HEAD
        with self.assertRaises(ValueError):
            self.bot.process(1)
        self.assertEqual(self.api.writes, [])

    def test_failed_pending_skipped_ci_or_external_check_blocks_completion(self):
        for status in ["failure", "cancelled", "skipped", "neutral", None]:
            with self.subTest(status=status):
                self.api.jobs[0]["conclusion"] = status
                self.assertTrue(self.bot.process(1).startswith("WAIT"))
                self.assertEqual(self.api.writes, [])
        self.api.jobs[0]["conclusion"] = "success"
        self.api.checks = [{"name": "external", "status": "in_progress", "conclusion": None}]
        self.assertTrue(self.bot.process(1).startswith("WAIT"))
        self.assertEqual(self.api.writes, [])

    def test_duplicate_mentions_and_native_completion_are_idempotent(self):
        self.api.pr["body"] = "Closes #42, #42"
        self.api.refs = {(REPO.lower(), 42)}
        self.assertEqual(self.bot.process(1), "COMPLETED: 1 issue(s)")
        self.assertEqual(self.bot.process(1), "COMPLETED: 0 issue(s)")
        self.assertEqual(len(self.api.writes), 1)

    def test_assignment_revoked_while_checks_are_read_is_preserved(self):
        verifier = merger.AutoMerge.current_ci
        def revoke(bot, candidate):
            self.api.issue["assignees"] = [{"login": "bob"}]
            return verifier(bot, candidate)
        with patch.object(merger.AutoMerge, "current_ci", revoke):
            self.assertEqual(self.bot.process(1), "COMPLETED: 0 issue(s)")
        self.assertEqual(self.api.writes, [])

    def test_closed_not_planned_is_marked_completed_only_when_assigned(self):
        self.api.issue.update(state="closed", state_reason="not_planned")
        self.assertEqual(self.bot.process(1), "COMPLETED: 1 issue(s)")
        self.assertEqual(self.api.issue["state_reason"], "completed")

    def test_dry_run_writes_nothing(self):
        self.assertEqual(self.bot.process(1, True), "WOULD COMPLETE: 1 issue(s)")
        self.assertEqual(self.api.writes, [])

    def test_partial_failure_is_retried_without_reclosing_completed_issues(self):
        self.api.pr["body"] = "Closes #42, #43"
        self.api.issues["43"] = copy.deepcopy(self.api.issue)
        request = self.api.request
        def fail(path, method="GET", data=None):
            if path.endswith("/issues/43") and method == "PATCH":
                raise urllib.error.HTTPError("https://api.github.com", 403, "denied", {}, None)
            return request(path, method, data)
        with patch.object(self.api, "request", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "periodic sweep will retry"):
                self.bot.process(1)
        self.assertEqual(self.api.issue["state_reason"], "completed")
        self.assertEqual(self.api.issues["43"]["state"], "open")
        self.assertEqual(self.bot.process(1), "COMPLETED: 1 issue(s)")

    def test_recent_reconciliation_paginates_and_stops_at_cutoff(self):
        recent = "2026-11-24T01:00:00Z"
        old = "2026-01-01T00:00:00Z"
        with patch.object(merger, "datetime") as clock:
            from datetime import datetime, timezone
            clock.now.return_value = datetime(2026, 11, 24, tzinfo=timezone.utc)
            clock.fromisoformat.side_effect = datetime.fromisoformat
            with patch.object(self.api, "pages", return_value=iter([
                {"number": 1, "updated_at": recent, "merged_at": recent},
                {"number": 2, "updated_at": recent, "merged_at": None},
                {"number": 3, "updated_at": old, "merged_at": old}])):
                self.assertEqual([x["number"] for x in self.bot.recent()], [1])


class AutoMergeTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeGitHub()
        self.policy = Mock()
        self.policy.decision.return_value = (True, "assigned")
        self.bot = merger.AutoMerge(self.api, self.policy, "dev")

    def assert_wait(self, text):
        result = self.bot.process(1)
        self.assertIn(text, result)
        self.assertFalse(any(path.endswith("/merge") for path, _, _ in self.api.writes))
        self.assertTrue(any(path.endswith("/comments") for path, _, _ in self.api.writes))

    def test_valid_pr_merges_with_expected_head_and_no_coauthor_trailers(self):
        self.assertTrue(self.bot.process(1).startswith("MERGED"))
        self.assertEqual(len(self.api.writes), 2)
        self.assertEqual(self.api.writes[1][2], {"state": "closed", "state_reason": "completed"})
        data = self.api.writes[0][2]
        self.assertEqual(data["sha"], HEAD)
        self.assertEqual(data["merge_method"], "merge")
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

    def test_main_gate_cannot_replace_the_required_dev_gate(self):
        self.api.jobs[0]["name"] = "gate"
        self.assert_wait("successful dev gate")

    def test_missing_gate_cannot_be_replaced_with_green_workflow(self):
        self.api.jobs = []
        self.assert_wait("successful dev gate")

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
        for item in [{"filename": ".github/workflows/dev-ci.yml"},
                     {"filename": "src/safe.py", "previous_filename": ".github/scripts/check.py"},
                     {"filename": "nested/AGENTS.md"}, {"filename": "CODEOWNERS"}]:
            with self.subTest(item=item):
                self.api.files = [{"status": "renamed" if "previous_filename" in item else "modified", **item}]
                self.assert_wait("requires maintainer review")

    def test_safety_requires_current_trusted_status_even_with_green_ci(self):
        status = self.api.safety_status[0]
        for statuses, reason in [([], "trusted PR safety status"),
                                 ([{**status, "state": "failure"}], "PR safety is failure"),
                                 ([{**status, "description": "Passed for an old base"}], "current dev base"),
                                 ([{**status, "creator": {"login": "contributor"}}], "must come from GitHub Actions")]:
            with self.subTest(statuses=statuses):
                self.api.safety_status = statuses
                self.assert_wait(reason)

    def test_green_status_cannot_override_unsafe_diff(self):
        self.api.files = [{"filename": ".gitignore", "status": "added", "additions": 1, "deletions": 0,
                           "patch": "@@ -0,0 +1 @@\n+example" + " " * 100 + "hidden text"}]
        self.assert_wait("wide gap")

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

    def add_action_run(self, run_id, checks, workflow_id=200, attempt=1, app_id=10):
        self.api.extra_runs[run_id] = {
            "id": run_id, "workflow_id": workflow_id, "run_attempt": attempt,
            "repository": {"full_name": REPO}, "head_sha": HEAD,
            "status": "completed", "conclusion": "success"}
        records = [{"id": check_id, "name": "matrix test", "head_sha": HEAD,
                    "app": {"id": app_id, "slug": "github-actions"},
                    "details_url": f"https://github.com/{REPO}/actions/runs/{run_id}/job/{check_id + 5000}",
                    "status": "completed", "conclusion": conclusion}
                   for check_id, conclusion in checks]
        self.api.checks.extend(records)
        # A job ID is deliberately different from its check ID.
        self.api.extra_jobs[(run_id, attempt)] = [
            {"id": check["id"] + 5000, "name": check["name"],
             "head_sha": HEAD, "status": check["status"], "conclusion": check["conclusion"],
             "check_run_url": f"https://api.github.com/repos/{REPO}/check-runs/{check['id']}"}
            for check in records]
        return records

    def test_main_ci_results_are_advisory_for_dev_integration(self):
        self.add_action_run(101, [(200, "failure")])
        self.api.extra_runs[101].update(path=merger.MAIN_CI_PATH, conclusion="failure")
        self.assertEqual(self.bot.checks(self.api.pr), [])

    def test_failed_dev_ci_still_blocks_dev_integration(self):
        self.add_action_run(101, [(200, "failure")])
        self.api.extra_runs[101]["path"] = merger.CI_PATH
        self.assertTrue(self.bot.checks(self.api.pr))

    def test_other_failed_workflow_still_blocks_dev_integration(self):
        self.add_action_run(101, [(200, "failure")])
        self.api.extra_runs[101]["path"] = ".github/workflows/other.yml"
        self.assertTrue(self.bot.checks(self.api.pr))

    def test_main_ci_failure_is_not_ignored_for_a_main_policy(self):
        self.add_action_run(101, [(200, "failure")])
        self.api.extra_runs[101]["path"] = merger.MAIN_CI_PATH
        self.bot.default_branch = "main"
        self.assertTrue(self.bot.checks(self.api.pr))

    def test_new_workflow_run_supersedes_failed_suite_even_with_larger_old_check_id(self):
        self.add_action_run(100, [(900, "failure")])
        self.add_action_run(101, [(200, "success")])
        self.assertEqual(self.bot.checks(pr()), [])

    def test_duplicate_matrix_names_in_latest_attempt_preserve_every_failure(self):
        self.add_action_run(101, [(200, "failure"), (201, "success")])
        self.assert_wait("matrix test")

    def test_previous_attempt_failure_is_replaced_using_check_urls_not_job_ids(self):
        records = self.add_action_run(101, [(200, "failure"), (201, "success")], attempt=2)
        self.api.extra_jobs[(101, 2)] = self.api.extra_jobs[(101, 2)][1:]
        self.assertEqual(self.bot.checks(pr()), [])
        self.assertNotEqual(records[1]["id"], self.api.extra_jobs[(101, 2)][0]["id"])

    def test_different_workflow_or_app_with_same_check_name_keeps_failure(self):
        for app_id, workflow_id in [(10, 201), (11, 200)]:
            with self.subTest(app_id=app_id, workflow_id=workflow_id):
                self.setUp()
                self.add_action_run(100, [(200, "failure")])
                self.add_action_run(101, [(201, "success")], app_id=app_id, workflow_id=workflow_id)
                self.assertTrue(self.bot.checks(pr()))

    def test_external_app_replacements_do_not_hide_other_app_failures(self):
        def check(check_id, app_id, conclusion):
            return {"id": check_id, "app": {"id": app_id, "slug": "external"},
                    "name": "external", "status": "completed", "conclusion": conclusion}
        self.api.checks = [check(1, 1, "failure"), check(2, 1, "success")]
        self.assertEqual(self.bot.checks(pr()), [])
        self.api.checks.append(check(3, 2, "failure"))
        self.assertTrue(self.bot.checks(pr()))

    def test_unverified_old_workflow_failure_cannot_be_hidden(self):
        for change in [{"id": 999}, {"id": True}, {"head_sha": BASE},
                       {"repository": {"full_name": "attacker/example"}}, {"workflow_id": False}]:
            with self.subTest(change=change):
                self.setUp()
                self.add_action_run(100, [(200, "failure")])
                self.add_action_run(101, [(201, "success")])
                self.api.extra_runs[100].update(change)
                self.assertTrue(self.bot.checks(pr()))

    def test_untrusted_check_url_or_wrong_check_head_does_not_hide_failure(self):
        for field, value in [("details_url", "https://evil.example/actions/runs/100/job/200"),
                             ("details_url", f"https://github.com/{REPO}/actions/runs/100/job/200?fake=1"),
                             ("head_sha", BASE)]:
            with self.subTest(field=field, value=value):
                self.setUp()
                rows = self.add_action_run(100, [(200, "failure")])
                self.add_action_run(101, [(201, "success")])
                rows[0][field] = value
                self.assertTrue(self.bot.checks(pr()))

    def test_missing_checks_listing_cannot_hide_current_job_failure(self):
        self.add_action_run(101, [(200, "success"), (201, "failure")])
        self.api.checks.pop()
        self.assertTrue(self.bot.checks(pr()))

    def test_lagging_successful_check_cannot_hide_current_job_failure(self):
        self.add_action_run(101, [(200, "failure")])
        self.api.checks[0]["conclusion"] = "success"
        self.assertTrue(self.bot.checks(pr()))

    def test_empty_or_unverifiable_latest_attempt_cannot_merge(self):
        self.add_action_run(101, [(200, "success")])
        for jobs in [[], [{"name": "test", "status": "completed", "conclusion": "success",
                           "check_run_url": "https://evil.example/check-runs/200"}]]:
            with self.subTest(jobs=jobs):
                self.api.extra_jobs[(101, 1)] = jobs
                with self.assertRaises(ValueError):
                    self.bot.process(1)
                self.assertEqual(self.api.writes, [])

    def test_latest_pending_workflow_or_new_attempt_is_refetched_and_blocks(self):
        self.add_action_run(101, [(200, "success")])
        self.assertEqual(self.bot.checks(pr()), [])
        self.api.extra_runs[101]["status"] = "in_progress"
        self.api.extra_runs[101]["conclusion"] = None
        self.assertTrue(self.bot.checks(pr()))
        self.api.extra_runs[101]["run_attempt"] = 2
        self.api.extra_jobs[(101, 2)] = [{"id": 999, "name": "pending rerun", "status": "queued",
                                        "conclusion": None,
                                        "check_run_url": f"https://api.github.com/repos/{REPO}/check-runs/201"}]
        self.assertTrue(self.bot.checks(pr()))
        self.assertEqual(self.api.reads.count(PREFIX + "actions/runs/101"), 3)

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
        self.assertNotIn("&\\#", value)
        self.assertEqual(merger.safe_text("Answer '## Summary'."), "Answer '\\#\\# Summary'.")

    def test_privileged_workflow_never_checks_out_or_downloads_artifacts(self):
        path = Path(__file__).resolve().parents[1] / "workflows/auto-merge-prs.yml"
        source = path.read_text()
        for forbidden in ["actions/checkout", "actions/download-artifact", "pull_request.head", "secrets."]:
            self.assertNotIn(forbidden, source)
        self.assertIn("github.workflow_sha", source)



class DevelopmentIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeGitHub()
        self.policy = Mock()
        self.policy.decision.return_value = (True, "assigned")
        self.bot = merger.AutoMerge(self.api, self.policy, "dev")

    def test_main_promotion_cannot_be_automatically_merged(self):
        self.api.pr["base"]["ref"] = "main"
        proof, reasons = self.bot.inspect(self.api.pr)
        self.assertIsNone(proof)
        self.assertTrue(any("dev" in reason for reason in reasons))
        self.assertEqual(self.api.writes, [])
        self.policy.decision.assert_not_called()

    def test_dev_merge_requires_the_dev_ci_workflow(self):
        self.api.run["path"] = ".github/workflows/ci.yml"
        _, reasons = self.bot.current_ci(self.api.pr)
        self.assertTrue(any("CI has not registered" in reason for reason in reasons))
        self.assertEqual(self.api.writes, [])

    def test_merged_dev_pr_completes_only_its_assigned_issue(self):
        self.api.pr.update(state="closed", merged=True,
                           merged_at="2026-11-25T12:00:00Z", merge_commit_sha=BASE)
        self.api.pr["body"] = "Closes #42"
        result = merger.IssueCompletion(self.api, "dev").process(1)
        self.assertIn("COMPLETED", result)
        self.assertEqual(self.api.issue["state_reason"], "completed")
        self.assertEqual(self.api.issue["assignees"], [{"login": "alice"}])

    def test_main_promotion_cannot_complete_a_dev_issue(self):
        self.api.pr.update(state="closed", merged=True,
                           merged_at="2026-11-25T12:00:00Z", merge_commit_sha=BASE)
        self.api.pr["base"]["ref"] = "main"
        self.api.pr["body"] = "Closes #42"
        merger.IssueCompletion(self.api, "dev").process(1)
        self.assertEqual(self.api.issue["state"], "open")
        self.assertEqual(self.api.writes, [])

if __name__ == "__main__":
    unittest.main()
