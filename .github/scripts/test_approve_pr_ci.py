"""Regression tests for privileged CI authorization, without running PR code."""

import copy
import unittest

from approve_pr_ci import Approval, event_number, matches, timestamp

REPO = "StellarHyperion/example"
HEAD = "a" * 40


def pr():
    return {"number": 42, "state": "open", "draft": False,
            "head": {"sha": HEAD, "ref": "fix", "repo": {"id": 2, "full_name": "contributor/example"}},
            "base": {"ref": "dev", "repo": {"full_name": REPO}}}


def run():
    return {"id": 7, "event": "pull_request", "path": ".github/workflows/dev-ci.yml",
            "repository": {"full_name": REPO}, "head_sha": HEAD, "head_branch": "fix",
            "head_repository": {"id": 2, "full_name": "contributor/example"},
            "status": "completed", "conclusion": "action_required"}


class Policy:
    def __init__(self):
        self.allowed = True
        self.calls = 0
        self.before_recheck = None

    def decision(self, _pr):
        self.calls += 1
        if self.calls == 2 and self.before_recheck:
            self.before_recheck(self)
        return self.allowed, "assigned" if self.allowed else "unassigned"


class GitHub:
    repository = REPO
    policy_ref = "dev"

    def __init__(self):
        self.pr = pr()
        self.run = run()
        self.approvals = []
        self.fetches = 0
        self.before_recheck = None
        self.failure = False
        self.registration_delay = 0
        self.extra_runs = []

    def request(self, path, method="GET", data=None):
        if self.failure:
            raise OSError("API unavailable")
        if method == "POST":
            self.approvals.append(path)
            return None
        if "/pulls/" in path:
            self.fetches += 1
            if self.fetches == 2 and self.before_recheck:
                self.before_recheck(self)
            return copy.deepcopy(self.pr)
        if "?" in path:
            if self.registration_delay:
                self.registration_delay -= 1
                return {"workflow_runs": []}
            return {"workflow_runs": copy.deepcopy([self.run, *self.extra_runs])}
        return copy.deepcopy(self.run)


class ApprovalTests(unittest.TestCase):
    def setUp(self):
        self.github = GitHub()
        self.policy = Policy()
        self.approval = Approval(self.github, self.policy)

    def test_assigned_author_starts_only_waiting_current_ci(self):
        self.assertIn("APPROVE", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [f"repos/{REPO}/actions/runs/7/approve"])
        self.assertEqual(self.policy.calls, 2)

    def test_only_newest_waiting_description_run_is_approved(self):
        older = run()
        self.github.run["id"] = 8
        self.github.extra_runs = [older]
        self.assertIn("APPROVE run 8", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [f"repos/{REPO}/actions/runs/8/approve"])

    def test_older_waiting_run_is_not_started_after_newest_has_started(self):
        older = run()
        self.github.run.update(id=8, status="in_progress", conclusion=None)
        self.github.extra_runs = [older]
        self.assertIn("SKIP", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [])

    def test_newer_run_registering_during_assignment_read_prevents_old_approval(self):
        newer = run()
        newer["id"] = 8
        self.policy.before_recheck = lambda _policy: self.github.extra_runs.append(newer)
        self.assertIn("newer matching CI run", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [])

    def test_unassigned_author_is_not_approved(self):
        self.policy.allowed = False
        self.assertIn("WAIT", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [])

    def test_assignment_revocation_before_mutation_is_respected(self):
        self.policy.before_recheck = lambda policy: setattr(policy, "allowed", False)
        self.assertIn("WAIT", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [])

    def test_closed_pr_is_not_approved(self):
        self.github.pr["state"] = "closed"
        self.assertIn("SKIP", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [])

    def test_head_change_before_mutation_is_respected(self):
        self.github.before_recheck = lambda github: github.pr["head"].update(sha="b" * 40)
        self.assertIn("SKIP", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [])

    def test_pr_closed_before_mutation_is_respected(self):
        self.github.before_recheck = lambda github: github.pr.update(state="closed")
        self.assertIn("SKIP", self.approval.approve(42)[0])
        self.assertEqual(self.github.approvals, [])

    def test_finished_checks_are_never_rewritten_or_reapproved(self):
        for conclusion in ["success", "failure", "cancelled"]:
            self.github.run["conclusion"] = conclusion
            self.assertIn("SKIP", self.approval.approve(42)[0])
            self.assertEqual(self.github.approvals, [])

    def test_draft_contributors_can_get_ci_feedback(self):
        self.github.pr["draft"] = True
        self.assertIn("APPROVE", self.approval.approve(42)[0])

    def test_wrong_event_workflow_repo_sha_or_branch_never_authorized(self):
        for change in [{"event": "workflow_dispatch"}, {"event": "pull_request_target"},
                       {"path": ".github/workflows/deploy.yml"}, {"head_sha": "b" * 40},
                       {"repository": {"full_name": "other/repo"}}, {"head_branch": "other"},
                       {"head_repository": {"id": 3, "full_name": "contributor/example"}},
                       {"head_repository": {"id": 2, "full_name": "attacker/example"}}]:
            with self.subTest(change=change):
                candidate = run()
                candidate.update(change)
                self.assertFalse(matches(pr(), candidate, REPO, "dev"))

    def test_non_default_base_and_same_repo_runs_are_excluded(self):
        for changes in [{"ref": "other"}, {"repo": {"full_name": "other/repo"}}]:
            current = pr()
            current["base"].update(changes)
            self.assertFalse(matches(current, run(), REPO, "dev"))
        current = pr()
        current["head"]["repo"] = {"id": 1, "full_name": REPO}
        candidate = run()
        candidate["head_repository"] = current["head"]["repo"]
        self.assertFalse(matches(current, candidate, REPO, "dev"))

    def test_invalid_identifiers_cannot_be_api_paths(self):
        for number in [True, -1, 0, "42/merge"]:
            with self.subTest(number=number), self.assertRaises(ValueError):
                self.approval.approve(number)
        self.github.pr["head"]["sha"] = "bad&head_sha=attacker"
        with self.assertRaises(ValueError):
            self.approval.approve(42)
        self.assertEqual(self.github.approvals, [])

    def test_missing_or_boolean_fork_identity_and_empty_branch_are_rejected(self):
        for identity in [{"id": True, "full_name": "contributor/example"},
                         {"id": 2}, {"id": 0, "full_name": "contributor/example"}]:
            current = pr()
            candidate = run()
            current["head"]["repo"] = identity
            candidate["head_repository"] = identity
            self.assertFalse(matches(current, candidate, REPO, "dev"))
        current = pr()
        candidate = run()
        current["head"]["ref"] = ""
        candidate["head_branch"] = ""
        self.assertFalse(matches(current, candidate, REPO, "dev"))
        candidate = run()
        candidate["head_repository"]["id"] = True
        self.assertFalse(matches(pr(), candidate, REPO, "dev"))

    def test_verification_error_never_approves_ci(self):
        self.github.failure = True
        with self.assertRaises(OSError):
            self.approval.approve(42)
        self.assertEqual(self.github.approvals, [])

    def test_pr_event_retries_run_registration_and_starts_ci(self):
        self.github.registration_delay = 2
        sleeps = []
        self.assertIn("APPROVE", self.approval.approve(42, registration_attempts=3, sleep=sleeps.append)[0])
        self.assertEqual(sleeps, [5, 5])
        self.assertEqual(len(self.github.approvals), 1)

    def test_registration_wait_is_bounded_and_does_not_approve_missing_ci(self):
        self.github.registration_delay = 10
        sleeps = []
        self.assertIn("WAIT", self.approval.approve(42, registration_attempts=3, sleep=sleeps.append)[0])
        self.assertEqual(sleeps, [5, 5])
        self.assertEqual(self.github.approvals, [])

    def test_unassigned_author_is_not_polled_or_approved(self):
        self.github.registration_delay = 10
        self.policy.allowed = False
        sleeps = []
        self.assertIn("WAIT", self.approval.approve(42, registration_attempts=3, sleep=sleeps.append)[0])
        self.assertEqual(sleeps, [])
        self.assertEqual(self.github.approvals, [])

    def test_new_head_or_issue_text_during_final_policy_read_is_rejected(self):
        for field, value in [("head", {"sha": "b" * 40}), ("body", "Fixes #99"), ("state", "closed")]:
            with self.subTest(field=field):
                self.setUp()
                def change(_policy):
                    if field == "head":
                        self.github.pr["head"].update(value)
                    else:
                        self.github.pr[field] = value
                self.policy.before_recheck = change
                self.assertIn("SKIP", self.approval.approve(42)[0])
                self.assertEqual(self.github.approvals, [])

    def test_trusted_event_selects_one_numeric_pr_only(self):
        self.assertEqual(event_number("pull_request_target", {"number": 42}), 42)
        self.assertIsNone(event_number("schedule", {"number": "unsafe"}))
        for value in [None, True, -1, 0, "42", "42/merge"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                event_number("pull_request_target", {"number": value})

    def test_description_edit_does_not_reuse_an_older_successful_run(self):
        self.github.run["conclusion"] = "success"
        self.github.run["created_at"] = "2026-11-19T00:00:00Z"
        def register(_seconds):
            self.github.run["conclusion"] = "action_required"
            self.github.run["created_at"] = "2026-11-19T01:00:01Z"
        rows = self.approval.approve(42, registration_attempts=2, sleep=register,
                                     not_before=timestamp("2026-11-19T01:00:00Z"))
        self.assertIn("APPROVE", rows[0])
        self.assertEqual(len(self.github.approvals), 1)

    def test_missing_or_unzoned_event_timestamp_is_rejected(self):
        for value in [None, "invalid", "2026-11-19T01:00:00"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                timestamp(value)



class DevelopmentAuthorizationTests(unittest.TestCase):
    def test_dev_run_is_authorized_for_an_assigned_contributor(self):
        github, policy = GitHub(), Policy()
        self.assertIn("APPROVE", Approval(github, policy).approve(42)[0])
        self.assertEqual(len(github.approvals), 1)

    def test_main_promotion_is_not_automatically_authorized(self):
        github, policy = GitHub(), Policy()
        github.pr["base"]["ref"] = "main"
        Approval(github, policy).approve(42)
        self.assertEqual(github.approvals, [])

    def test_full_main_ci_cannot_authorize_a_dev_pull_request(self):
        github, policy = GitHub(), Policy()
        github.run["path"] = ".github/workflows/ci.yml"
        Approval(github, policy).approve(42)
        self.assertEqual(github.approvals, [])

if __name__ == "__main__":
    unittest.main()
