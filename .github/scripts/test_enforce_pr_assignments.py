"""Authorization regression tests for a workflow that can close external PRs."""

import importlib.util
import contextlib
import io
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("policy", Path(__file__).with_name("enforce_pr_assignments.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
REPO = "StellarHyperion/example"


def pr(author="contributor", body="Closes #7", **changes):
    value = {"number": 42, "title": "Change behavior", "body": body, "state": "open",
             "user": {"login": author, "type": "User"}, "author_association": "FIRST_TIME_CONTRIBUTOR"}
    value.update(changes)
    return value


class FakeGitHub:
    repository = REPO

    def __init__(self, assignees=("contributor",), permission="read", owners=()):
        self.owners = set(owners)
        self.permission = permission
        self.issues = {("stellarhyperion/example", 7): {"assignees": [{"login": x} for x in assignees]}}
        self.links = set()
        self.current = pr()
        self.updates = []
        self.failure = None
        self.fetches = 0
        self.on_second_fetch = None

    def codeowners(self):
        return self.owners

    def linked_issues(self, number):
        if self.failure:
            raise self.failure
        return self.links

    def request(self, path, method="GET", data=None):
        if method == "PATCH":
            self.updates.append((path, data))
            return {"state": "closed", "merged": False}
        if path.endswith("/permission"):
            return {"permission": self.permission}
        if "/pulls/" in path:
            self.fetches += 1
            if self.fetches == 2 and self.on_second_fetch:
                self.on_second_fetch(self)
            return self.current
        target = path.removeprefix("repos/").split("/issues/")
        return self.issues[(target[0], int(target[1]))]


class AssignmentTests(unittest.TestCase):
    def test_issue_references(self):
        self.assertEqual(policy.text_references("Closes #7; fixes StellarHyperion/other#8 and https://github.com/StellarHyperion/other/issues/9", REPO),
                         {("stellarhyperion/example", 7), ("stellarhyperion/other", 8), ("stellarhyperion/other", 9)})

    def test_comments_and_examples_are_not_assignments(self):
        text = "<!-- Closes #1 -->\n```md\nFixes #2\n```\n~~~\n#3\n~~~\nReferences #7"
        self.assertEqual(policy.text_references(text, REPO), {("stellarhyperion/example", 7)})

    def test_external_url_fragment_is_not_local_issue(self):
        self.assertEqual(policy.text_references("https://elsewhere.test/page#7", REPO), set())

    def test_codeowners_extract_users_not_comments_patterns_or_teams(self):
        text = "# @comment\n* @Owner @org/team\n/src @Second # @ignored\n"
        self.assertEqual(policy.codeowner_users(text), {"owner", "second"})

    def test_assigned_contributor_remains_open(self):
        github = FakeGitHub()
        self.assertEqual(policy.Enforcement(github).enforce(pr())[0], "KEEP")
        self.assertEqual(github.updates, [])

    def test_public_read_permission_does_not_exempt_unassigned_author(self):
        github = FakeGitHub(assignees=(), permission="read")
        status, reason = policy.Enforcement(github).enforce(pr())
        self.assertEqual(status, "CLOSE")
        self.assertIn("not assigned", reason)
        self.assertEqual(github.updates, [(f"repos/{REPO}/pulls/42", {"state": "closed"})])

    def test_assigned_to_someone_else_closes(self):
        github = FakeGitHub(assignees=("other",))
        self.assertEqual(policy.Enforcement(github).enforce(pr())[0], "CLOSE")

    def test_case_insensitive_assignee(self):
        self.assertTrue(policy.Enforcement(FakeGitHub(assignees=("CONTRIBUTOR",))).decision(pr())[0])

    def test_multiple_issues_require_assignment_to_each(self):
        github = FakeGitHub()
        github.issues[("stellarhyperion/example", 8)] = {"assignees": [{"login": "other"}]}
        self.assertFalse(policy.Enforcement(github).decision(pr(body="Closes #7, #8"))[0])

    def test_manual_link_and_commit_closing_references_count(self):
        github = FakeGitHub()
        github.links = {("stellarhyperion/example", 7)}
        self.assertTrue(policy.Enforcement(github).decision(pr(body="Implementation"))[0])

    def test_sister_repository_assignment(self):
        github = FakeGitHub()
        github.issues[("stellarhyperion/sister", 8)] = {"assignees": [{"login": "contributor"}]}
        self.assertTrue(policy.Enforcement(github).decision(pr(body="Fixes StellarHyperion/sister#8"))[0])

    def test_external_self_assigned_issue_cannot_authorize(self):
        self.assertFalse(policy.Enforcement(FakeGitHub()).decision(pr(body="Fixes outsider/project#8"))[0])

    def test_missing_issue_closes(self):
        self.assertFalse(policy.Enforcement(FakeGitHub()).decision(pr(body="Implementation"))[0])

    def test_reference_to_another_pr_is_not_an_issue(self):
        github = FakeGitHub()
        github.issues[("stellarhyperion/example", 7)]["pull_request"] = {}
        self.assertFalse(policy.Enforcement(github).decision(pr())[0])

    def test_bot_exemptions(self):
        for login in policy.TRUSTED_BOTS:
            with self.subTest(login=login):
                github = FakeGitHub()
                github.current = pr(author=login, body="", user={"login": login, "type": "Bot"})
                self.assertEqual(policy.Enforcement(github).enforce(pr())[0], "KEEP")

    def test_unknown_bot_requires_assignment(self):
        value = pr(author="unknown[bot]", body="", user={"login": "unknown[bot]", "type": "Bot"})
        self.assertFalse(policy.Enforcement(FakeGitHub()).decision(value)[0])

    def test_configured_service_account_is_exempt(self):
        self.assertTrue(policy.Enforcement(FakeGitHub(), " helper-account ").decision(pr(author="helper-account", body=""))[0])

    def test_roles_and_associations_are_exempt(self):
        for association in policy.TRUSTED_ASSOCIATIONS:
            self.assertTrue(policy.Enforcement(FakeGitHub()).decision(pr(body="", author_association=association))[0])
        for permission in ["admin", "maintain", "write", "triage"]:
            self.assertTrue(policy.Enforcement(FakeGitHub(permission=permission)).decision(pr(body=""))[0])

    def test_past_contribution_does_not_exempt(self):
        self.assertFalse(policy.Enforcement(FakeGitHub(assignees=())).decision(pr(author_association="CONTRIBUTOR"))[0])

    def test_default_branch_codeowner_is_exempt(self):
        self.assertTrue(policy.Enforcement(FakeGitHub(owners=("contributor",))).decision(pr(body=""))[0])

    def test_dry_run_does_not_mutate(self):
        github = FakeGitHub(assignees=())
        self.assertEqual(policy.Enforcement(github).enforce(pr(), dry_run=True)[0], "WOULD CLOSE")
        self.assertEqual(github.updates, [])

    def test_api_failure_preserves_pr(self):
        github = FakeGitHub(assignees=())
        github.failure = RuntimeError("GraphQL unavailable")
        with self.assertRaises(RuntimeError):
            policy.Enforcement(github).enforce(pr())
        self.assertEqual(github.updates, [])

    def test_assignment_changed_before_closure_is_kept(self):
        github = FakeGitHub(assignees=())
        def assigned(client):
            client.issues[("stellarhyperion/example", 7)]["assignees"] = [{"login": "contributor"}]
        github.on_second_fetch = assigned
        self.assertEqual(policy.Enforcement(github).enforce(pr())[0], "KEEP")
        self.assertEqual(github.updates, [])

    def test_closed_pr_is_skipped(self):
        github = FakeGitHub(assignees=())
        github.current["state"] = "closed"
        self.assertEqual(policy.Enforcement(github).enforce(pr())[0], "SKIP")
        self.assertEqual(github.updates, [])

    def test_full_sweep_snapshots_pages_before_closing(self):
        github = FakeGitHub(assignees=())
        def pages(path):
            yield pr()
            # Closing page one first would shift page two and skip open PRs.
            self.assertEqual(github.updates, [])
            yield pr(number=43)
        github.pages = pages
        with patch.object(policy, "GitHub", return_value=github), patch.object(policy.time, "sleep"), \
                patch.dict(policy.os.environ, {"GITHUB_TOKEN": "unused", "GITHUB_REPOSITORY": REPO,
                                              "POLICY_REF": "main"}, clear=True), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(policy.main(), 0)
        self.assertEqual(len(github.updates), 2)

    def test_sweep_api_failure_fails_run_without_closing(self):
        github = FakeGitHub(assignees=())
        github.failure = RuntimeError("GraphQL unavailable")
        github.pages = lambda path: iter([pr()])
        with patch.object(policy, "GitHub", return_value=github), \
                patch.dict(policy.os.environ, {"GITHUB_TOKEN": "unused", "GITHUB_REPOSITORY": REPO,
                                              "POLICY_REF": "main"}, clear=True), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(policy.main(), 1)
        self.assertEqual(github.updates, [])

    def test_link_pagination(self):
        github = policy.GitHub("unused", REPO, "main")
        responses = [
            {"data": {"repository": {"pullRequest": {"closingIssuesReferences": {
                "nodes": [{"number": 7, "repository": {"nameWithOwner": REPO}}],
                "pageInfo": {"hasNextPage": True, "endCursor": "next"}}}}}},
            {"data": {"repository": {"pullRequest": {"closingIssuesReferences": {
                "nodes": [{"number": 8, "repository": {"nameWithOwner": REPO}}],
                "pageInfo": {"hasNextPage": False, "endCursor": None}}}}}},
        ]
        cursors = []
        def request(path, method, data):
            cursors.append(data["variables"]["after"])
            return responses.pop(0)
        github.request = request
        self.assertEqual(github.linked_issues(42), {("stellarhyperion/example", 7), ("stellarhyperion/example", 8)})
        self.assertEqual(cursors, [None, "next"])


if __name__ == "__main__":
    unittest.main()
