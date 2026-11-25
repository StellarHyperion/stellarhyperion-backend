"""Merge tested, assignment-authorized PRs without executing contributor code.

This is a test-based policy, not a semantic issue reviewer. It requires real
issue links and the existing description attestations; only acceptance tests
can mechanically establish that a particular issue's behavior is implemented.
"""

import base64
from datetime import datetime, timedelta, timezone
import html
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse

from check_pr_description import DEPENDENCY_BOTS, validate_description, visible_markdown
from enforce_pr_assignments import Enforcement, GitHub, text_references

CI_PATH = ".github/workflows/dev-ci.yml"
MAIN_CI_PATH = ".github/workflows/ci.yml"
BOT_LOGIN = "github-actions[bot]"
MARKER = "<!-- hyperion-auto-merge:v1 -->"
SHA = re.compile(r"[0-9a-f]{40}")
ISSUE_TARGET = (r"(?:https://github\.com/[\w.-]+/[\w.-]+/issues/[1-9]\d*"
                r"|[\w.-]+/[\w.-]+#[1-9]\d*|#[1-9]\d*)\b")
CLOSING_REFERENCE = re.compile(
    r"\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?[ \t]+"
    + ISSUE_TARGET + r"(?:[ \t]*,[ \t]*(?:and[ \t]+)?" + ISSUE_TARGET + r")*", re.IGNORECASE)
THREADS_QUERY = """
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""


def state(pr):
    """Fields whose change invalidates admission, including title and base SHA."""
    head, base, user = pr["head"], pr["base"], pr["user"]
    fork, target = head.get("repo") or {}, base.get("repo") or {}
    return (pr["state"], pr.get("draft"), pr.get("title"), pr.get("body"),
            pr.get("author_association"), user["login"], user["type"],
            head["sha"], head["ref"], fork.get("id"), fork.get("full_name"),
            base["sha"], base["ref"], target.get("id"), target.get("full_name"))


def run_matches(pr, run, repository):
    head = pr["head"]
    fork, run_fork = head.get("repo") or {}, run.get("head_repository") or {}
    return (run.get("event") == "pull_request" and run.get("path") == CI_PATH
            and run.get("repository", {}).get("full_name", "").lower() == repository.lower()
            and run.get("head_sha") == head["sha"] and run.get("head_branch") == head["ref"]
            and type(fork.get("id")) is int and fork["id"] > 0
            and fork.get("id") == run_fork.get("id")
            and fork.get("full_name", "").lower() == run_fork.get("full_name", "").lower())


def safe_text(value):
    # Untrusted titles, names and diagnostics must not notify users or inject HTML/Markdown.
    value = " ".join(str(value).split())[:700]
    value = re.sub(r"([\\`*_{}\[\]()#!|])", r"\\\1", value)
    return html.escape(value, quote=False).replace("@", "&#64;")


def completion_references(body, repository):
    """Only positive closing declarations, never incidental issue mentions."""
    refs = set()
    for line in visible_markdown(body).splitlines():
        if re.search(r"\b(?:not|never|don't)\s+(?:close|fix|resolve)\b", line, re.IGNORECASE):
            continue
        for match in CLOSING_REFERENCE.finditer(line):
            refs |= text_references(match[0], repository)
    return refs


class AutoMerge:
    def __init__(self, github, policy, default_branch):
        self.github, self.policy, self.default_branch = github, policy, default_branch
        self.prefix = f"repos/{github.repository}/"
        self.template = None

    def items(self, path, key):
        for page in range(1, 31):
            separator = "&" if "?" in path else "?"
            response = self.github.request(f"{self.prefix}{path}{separator}per_page=100&page={page}")
            batch = response.get(key)
            if not isinstance(batch, list):
                raise ValueError("Missing paginated API result")
            yield from batch
            if len(batch) < 100:
                return
        raise ValueError("API pagination exceeded its limit")

    def content(self, path):
        query = urllib.parse.urlencode({"ref": self.github.policy_ref})
        result = self.github.request(self.prefix + "contents/" + path + "?" + query)
        if result.get("type") != "file" or result.get("encoding") != "base64":
            raise ValueError("Trusted policy content unavailable")
        return base64.b64decode(result["content"]).decode("utf-8")

    def current_ci(self, pr):
        runs = [run for run in self.items(
            f"actions/workflows/dev-ci.yml/runs?event=pull_request&head_sha={pr['head']['sha']}",
            "workflow_runs") if run_matches(pr, run, self.github.repository)]
        if not runs:
            return None, ["CI has not registered for this revision. Wait for CI; authorized fork CI is started by Automatic PR CI."]
        if any(type(run.get("id")) is not int or run["id"] <= 0 for run in runs):
            raise ValueError("Invalid CI run identifier")
        run = max(runs, key=lambda item: item["id"])
        run = self.github.request(self.prefix + f"actions/runs/{run['id']}")
        if not run_matches(pr, run, self.github.repository):
            raise ValueError("CI provenance changed")
        attempt = run.get("run_attempt")
        if type(attempt) is not int or attempt <= 0:
            raise ValueError("Invalid CI attempt")
        jobs = list(self.items(f"actions/runs/{run['id']}/attempts/{attempt}/jobs", "jobs"))
        url = f"https://github.com/{self.github.repository}/actions/runs/{run['id']}"
        reasons = []
        for job in jobs:
            if job.get("status") != "completed" or job.get("conclusion") != "success":
                reasons.append(f"CI job {job.get('name', 'unknown')} is {job.get('conclusion') or job.get('status', 'pending')}. Fix it or wait for completion. {url}")
        if run.get("status") != "completed" or run.get("conclusion") != "success":
            reasons.append(f"The newest CI attempt is {run.get('conclusion') or run.get('status', 'pending')}. All required development checks must succeed. {url}")
        gates = [job for job in jobs if job.get("name") == "gate"]
        if len(gates) != 1 or gates[0].get("conclusion") != "success":
            reasons.append(f"The current CI attempt must contain a successful gate job. {url}")
        if any(job.get("head_sha") != pr["head"]["sha"] for job in jobs):
            raise ValueError("CI jobs do not match the current revision")
        return (run["id"], attempt), reasons

    def issues(self, pr):
        refs = text_references(pr.get("title"), self.github.repository)
        refs |= text_references(pr.get("body"), self.github.repository)
        refs |= self.github.linked_issues(pr["number"])
        issues = []
        for repo, number in sorted(refs):
            issue = self.github.request(f"repos/{repo}/issues/{number}")
            if "pull_request" not in issue:
                issues.append((repo, number, issue.get("title"), issue.get("body"), issue.get("state"),
                               tuple(sorted(user["login"].lower() for user in issue["assignees"]))))
        return tuple(issues)

    def conversations(self, pr):
        owner, repo = self.github.repository.split("/")
        after = None
        for _ in range(30):
            result = self.github.request("graphql", "POST", {"query": THREADS_QUERY, "variables": {
                "owner": owner, "repo": repo, "number": pr["number"], "after": after}})
            if result.get("errors"):
                raise ValueError("Review conversations could not be verified")
            connection = result["data"]["repository"]["pullRequest"]["reviewThreads"]
            if any(node.get("isResolved") is not True for node in connection["nodes"]):
                return ["Resolve every open review conversation after addressing its feedback."]
            if not connection["pageInfo"]["hasNextPage"]:
                break
            cursor = connection["pageInfo"]["endCursor"]
            if not cursor or cursor == after:
                raise ValueError("Conversation pagination did not advance")
            after = cursor
        else:
            raise ValueError("Conversation pagination exceeded its limit")
        latest = {}
        for review in self.github.pages(self.prefix + f"pulls/{pr['number']}/reviews"):
            if review.get("state") in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
                latest[review["user"]["login"].lower()] = review
        if any(review["state"] == "CHANGES_REQUESTED" for review in latest.values()):
            return ["Address the requested changes, then ask the reviewer to approve or dismiss their change request."]
        return []

    def latest_checks(self, sha):
        # "latest" is per suite. Select the latest workflow run and attempt explicitly,
        # retaining every job (including matrix jobs with identical display names).
        selected, unidentified, workflows, action_groups = {}, [], {}, {}
        for check in self.items(f"commits/{sha}/check-runs?filter=all", "check_runs"):
            app = check.get("app") or {}
            app_id, check_id, name = app.get("id"), check.get("id"), check.get("name")
            if (type(app_id) is not int or app_id <= 0 or type(check_id) is not int
                    or check_id <= 0 or not isinstance(name, str) or not name):
                unidentified.append(check)
                continue
            key = (app_id, name)
            if app.get("slug") != "github-actions":
                previous = selected.get(key)
                if previous is None or check_id > previous["id"]:
                    selected[key] = check
                continue
            match = re.fullmatch(
                r"https://github\.com/" + re.escape(self.github.repository)
                + r"/actions/runs/([1-9][0-9]*)(?:/job/[1-9][0-9]*)?",
                check.get("details_url") or "", re.IGNORECASE)
            if not match:
                unidentified.append(check)
                continue
            run_id = int(match[1])
            if run_id not in workflows:
                workflows[run_id] = self.github.request(self.prefix + f"actions/runs/{run_id}")
            run = workflows[run_id]
            workflow_id, attempt = run.get("workflow_id"), run.get("run_attempt")
            if (type(run.get("id")) is not int or run.get("id") != run_id or check.get("head_sha") != sha
                    or run.get("repository", {}).get("full_name", "").lower() != self.github.repository.lower()
                    or run.get("head_sha") != sha or type(workflow_id) is not int or workflow_id <= 0
                    or type(attempt) is not int or attempt <= 0):
                unidentified.append(check)
                continue
            # Full main promotion results are advisory for dev integration. Only
            # this provenance-verified workflow path is excluded; failed dev CI
            # and all other workflows or external checks remain blocking.
            if self.default_branch == "dev" and run.get("path") == MAIN_CI_PATH:
                continue
            # A different workflow using the same job name must not hide a failure.
            action_groups.setdefault((app_id, workflow_id), {}).setdefault(run_id, []).append(check)
        result = unidentified + list(selected.values())
        for runs in action_groups.values():
            run_id = max(runs)
            run = workflows[run_id]
            jobs = list(self.items(f"actions/runs/{run_id}/attempts/{run['run_attempt']}/jobs", "jobs"))
            if not jobs:
                raise ValueError("Latest workflow attempt has no verifiable jobs")
            ids = set()
            for job in jobs:
                match = re.fullmatch(
                    r"https://api\.github\.com/repos/" + re.escape(self.github.repository)
                    + r"/check-runs/([1-9][0-9]*)", job.get("check_run_url") or "", re.IGNORECASE)
                if not match:
                    raise ValueError("Latest workflow job has no verifiable check identity")
                ids.add(int(match[1]))
            # Job results cover checks not yet listed by the Checks API. Keep raw checks
            # from this attempt too, and preserve any newer unaccounted-for check.
            result.extend(jobs)
            result.extend(check for check in runs[run_id]
                          if check["id"] in ids or run["run_attempt"] == 1 or check["id"] > max(ids))
            result.append({"name": f"Workflow {run.get('name') or run_id}",
                           "status": run.get("status"), "conclusion": run.get("conclusion")})
        return result

    def checks(self, pr):
        reasons = []
        revisions = {pr["head"]["sha"]}
        merge_sha = pr.get("merge_commit_sha")
        if isinstance(merge_sha, str) and SHA.fullmatch(merge_sha):
            revisions.add(merge_sha)
        for sha in sorted(revisions):
            for check in self.latest_checks(sha):
                if check.get("status") != "completed" or check.get("conclusion") != "success":
                    reasons.append(f"Check {check.get('name', 'unknown')} is {check.get('conclusion') or check.get('status', 'pending')}. All checks must report success.")
            # Status API ordering is newest first; superseded statuses are ignored by context.
            seen = set()
            for status in self.github.pages(self.prefix + f"commits/{sha}/statuses"):
                context = status.get("context")
                if context in seen:
                    continue
                seen.add(context)
                if status.get("state") != "success":
                    reasons.append(f"Status {context} is {status.get('state', 'pending')}. Fix it or wait for success.")
        return reasons

    def inspect(self, pr):
        reasons = []
        if pr["state"] != "open":
            return None, ["PR is closed."]
        if pr.get("draft"):
            reasons.append("Mark this PR ready for review when its changes are complete.")
        if pr["base"]["ref"] != self.default_branch or pr["base"]["repo"]["full_name"].lower() != self.github.repository.lower():
            return None, [f"Target the repository's {self.default_branch} branch to use automatic merging."]
        for sha in [pr["head"]["sha"], pr["base"]["sha"]]:
            if not isinstance(sha, str) or not SHA.fullmatch(sha):
                raise ValueError("Invalid PR revision")
        allowed, reason = self.policy.decision(pr)
        if not allowed:
            reasons.append("Assignment policy: " + reason + ". Request assignment before reopening; the existing enforcement workflow closes unauthorized PRs.")
        issues = self.issues(pr)
        organization = self.github.repository.split("/")[0].lower()
        if not any(repo.split("/")[0] == organization for repo, *_ in issues):
            reasons.append("Reference at least one real StellarHyperion issue in the title or description (for example, Closes #42). PR references and outside issues do not grant eligibility.")
        if self.template is None:
            self.template = self.content(".github/pull_request_template.md")
        user = pr["user"]
        if not (user["type"] == "Bot" and user["login"].lower() in DEPENDENCY_BOTS):
            reasons.extend(validate_description(pr.get("body"), self.template))
        ci, ci_reasons = self.current_ci(pr)
        reasons.extend(ci_reasons)
        if pr.get("mergeable") is False:
            reasons.append("Resolve merge conflicts with the default branch and push the result.")
        elif pr.get("mergeable") is not True:
            reasons.append("GitHub is still calculating mergeability. The bot will retry automatically.")
        if pr.get("mergeable_state") == "behind":
            reasons.append("Update your branch with the latest default branch, then let CI run again.")
        if reasons:
            return None, reasons
        # Require that the tested head includes current dev, even if an administrator
        # has temporarily disabled GitHub's strict status check setting.
        compare = self.github.request(self.prefix + f"compare/{pr['base']['sha']}...{pr['head']['sha']}")
        if compare.get("merge_base_commit", {}).get("sha") != pr["base"]["sha"] or compare.get("status") not in {"ahead", "identical"}:
            reasons.append("Update your branch with the latest default branch, then let CI run again.")
        files = list(self.github.pages(self.prefix + f"pulls/{pr['number']}/files"))
        if len(files) != pr.get("changed_files"):
            raise ValueError("GitHub did not return the complete changed-file list")
        # A contributor must not replace the very workflows/scripts producing green
        # checks. Control-plane changes are a maintainer task, not automatic merges.
        protected = [name for item in files for name in [item["filename"], item.get("previous_filename", "")]
                     if name.startswith(".github/") or name in {"CODEOWNERS", "docs/CODEOWNERS"}
                     or name.rsplit("/", 1)[-1].lower() in {"agent.md", "agents.md", ".gitleaksignore"}]
        if protected:
            reasons.append("Maintainer merge required for changes to CI, automation, agent instructions, or security policy: " + ", ".join(sorted(set(protected))))
        reasons.extend(self.conversations(pr))
        reasons.extend(self.checks(pr))
        return (state(pr), issues, ci), reasons

    def comment(self, number, reasons, dry_run=False):
        pr = self.github.request(self.prefix + f"pulls/{number}")
        if pr["state"] != "open":
            return
        body = MARKER + "\n**Automatic merge is waiting.**\n\n"
        unique = list(dict.fromkeys(reasons))
        body += "\n".join("- " + safe_text(reason) for reason in unique[:40])
        if len(unique) > 40:
            body += "\n- More checks are blocked; inspect the CI run for the complete list."
        body += "\n\nThe bot retries after CI completes and during periodic sweeps. Tests and issue links are checked; semantic issue resolution is not reviewed by a model."
        comments = list(self.github.pages(self.prefix + f"issues/{number}/comments"))
        owned = [item for item in comments if item.get("user", {}).get("login") == BOT_LOGIN
                 and item.get("user", {}).get("type") == "Bot" and item.get("body", "").startswith(MARKER)]
        if dry_run:
            return
        if owned:
            existing = max(owned, key=lambda item: item["id"])
            if existing["body"] != body:
                self.github.request(self.prefix + f"issues/comments/{existing['id']}", "PATCH", {"body": body})
        else:
            self.github.request(self.prefix + f"issues/{number}/comments", "POST", {"body": body})

    def process(self, number, dry_run=False):
        if type(number) is not int or number <= 0:
            raise ValueError("Invalid PR number")
        endpoint = self.prefix + f"pulls/{number}"
        pr = self.github.request(endpoint)
        if pr["state"] != "open":
            return "SKIP: already closed"
        snapshot, reasons = self.inspect(pr)
        if not reasons:
            # Fetch all admission evidence again: comments/assignments/issues/CI reruns
            # and the base branch can change while the first inspection is running.
            latest = self.github.request(endpoint)
            fresh, reasons = self.inspect(latest)
            if not reasons and fresh != snapshot:
                reasons = ["The PR, referenced issues, assignments, base branch, or CI attempt changed during verification. The bot will retry."]
            if not reasons:
                final = self.github.request(endpoint)
                branch = urllib.parse.quote(self.default_branch, safe="")
                ref = self.github.request(self.prefix + "git/ref/heads/" + branch)
                if state(final) != state(latest) or ref["object"]["sha"] != latest["base"]["sha"] or final.get("mergeable") is not True:
                    reasons = ["The PR or default branch changed just before merging. Update the branch if needed; the bot will retry."]
                elif dry_run:
                    return "WOULD MERGE: all test-based policy checks passed"
                else:
                    try:
                        result = self.github.request(endpoint + "/merge", "PUT", {
                            "sha": latest["head"]["sha"], "merge_method": "merge",
                            "commit_title": f"Merge PR #{number}",
                            "commit_message": "Automatically merged after CI, issue-link and assignment verification."})
                        if result.get("merged") is True:
                            # GITHUB_TOKEN merges do not trigger another Actions workflow.
                            # Complete issues here too; periodic reconciliation retries errors.
                            completed = IssueCompletion(self.github, self.default_branch).process(number)
                            return "MERGED: all test-based policy checks passed; " + completed
                        reasons = ["GitHub declined the merge. A maintainer must inspect branch rules and merge permissions."]
                    except urllib.error.HTTPError as error:
                        if error.code not in {403, 405, 409, 422}:
                            raise
                        reasons = [f"GitHub refused the merge (HTTP {error.code}). Check branch protection, pending checks, unresolved conversations and whether the head changed. A maintainer may need to fix repository permissions."]
        self.comment(number, reasons, dry_run)
        return "WAIT: " + "; ".join(reasons)


class IssueCompletion:
    """Complete declared closing/development links only after a real merge.

    Mentions in comments/fenced examples, other organizations and PR references
    are excluded by the same reference parser and real-issue checks as admission.
    Every target must still be assigned to the original PR author, even when
    that author has a maintainer role. Successful current-head PR CI and all
    head checks are required for reconciliation as well as immediate completion.
    Assignees, PR authors and commit history are never modified.
    """

    def __init__(self, github, default_branch):
        self.github, self.default_branch = github, default_branch
        self.prefix = f"repos/{github.repository}/"

    def process(self, number, dry_run=False):
        if type(number) is not int or number <= 0:
            raise ValueError("Invalid PR number")
        pr = self.github.request(self.prefix + f"pulls/{number}")
        base = pr.get("base") or {}
        if (pr.get("state") != "closed" or pr.get("merged") is not True
                or not pr.get("merged_at") or base.get("ref") != self.default_branch
                or base.get("repo", {}).get("full_name", "").lower() != self.github.repository.lower()):
            return "SKIP: PR was not merged into the default branch"
        merge_sha = pr.get("merge_commit_sha")
        if not isinstance(merge_sha, str) or not SHA.fullmatch(merge_sha):
            raise ValueError("Missing verified merge revision")
        branch = urllib.parse.quote(self.default_branch, safe="")
        comparison = self.github.request(self.prefix + f"compare/{merge_sha}...{branch}")
        if (comparison.get("merge_base_commit", {}).get("sha") != merge_sha
                or comparison.get("status") not in {"ahead", "identical"}):
            raise ValueError("Merged revision is not on the current default branch")
        author = pr["user"]["login"].lower()
        refs = completion_references(pr.get("body"), self.github.repository)
        refs |= self.github.linked_issues(number)
        organization = self.github.repository.split("/")[0].lower()
        refs = {(repo, issue) for repo, issue in refs if repo.split("/")[0] == organization}
        candidates = []
        for repo, issue_number in sorted(refs):
            issue = self.github.request(f"repos/{repo}/issues/{issue_number}")
            if ("pull_request" not in issue
                    and author in {user["login"].lower() for user in issue["assignees"]}
                    and not (issue.get("state") == "closed" and issue.get("state_reason") == "completed")):
                candidates.append((repo, issue_number))
        if not candidates:
            return "COMPLETED: 0 issue(s)"
        verifier = AutoMerge(self.github, None, self.default_branch)
        _, reasons = verifier.current_ci(pr)
        # Post-merge push checks are separate from the PR's checks. The original
        # PR head must pass every gate; a newer failed/pending rerun blocks closure.
        reasons.extend(verifier.checks({**pr, "merge_commit_sha": None}))
        if reasons:
            return "WAIT: PR checks have not all succeeded; issues preserved"
        completed, errors = 0, []
        for repo, issue_number in candidates:
            try:
                endpoint = f"repos/{repo}/issues/{issue_number}"
                issue = self.github.request(endpoint)
                if "pull_request" in issue:
                    continue
                if author not in {user["login"].lower() for user in issue["assignees"]}:
                    continue
                # Native GitHub closing keywords may already have completed it.
                if issue.get("state") == "closed" and issue.get("state_reason") == "completed":
                    continue
                if dry_run:
                    completed += 1
                    continue
                updated = self.github.request(endpoint, "PATCH", {
                    "state": "closed", "state_reason": "completed"})
                if updated.get("state") != "closed" or updated.get("state_reason") != "completed":
                    raise ValueError("Issue completion was not confirmed")
                completed += 1
            except Exception as error:
                # Preserve partial success and try every issue before failing the run.
                errors.append(f"{repo}#{issue_number}: {type(error).__name__}")
        if errors:
            raise RuntimeError("Issue completion failed; periodic sweep will retry: " + "; ".join(errors))
        return f"{'WOULD COMPLETE' if dry_run else 'COMPLETED'}: {completed} issue(s)"

    def recent(self):
        # Updated order allows an early stop. A recently edited old PR is also
        # reconciled; the initial historical backfill is a maintainer operation.
        cutoff = datetime.now(timezone.utc) - timedelta(days=7)
        for pr in self.github.pages(self.prefix + "pulls?state=closed&sort=updated&direction=desc"):
            if datetime.fromisoformat(pr["updated_at"].replace("Z", "+00:00")) < cutoff:
                return
            if pr.get("merged_at"):
                yield pr


def main():
    github = GitHub(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ["POLICY_SHA"])
    policy = Enforcement(github, os.environ.get("PR_ASSIGNMENT_HELPER_BOTS", ""))
    bot = AutoMerge(github, policy, os.environ["DEFAULT_BRANCH"])
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    dry_run = os.environ.get("DRY_RUN", "false").lower() == "true"
    event_name = os.environ["GITHUB_EVENT_NAME"]
    completion = IssueCompletion(github, bot.default_branch)
    if event_name == "pull_request_target":
        prs = []
        merged = [event["pull_request"]]
    else:
        prs = list(github.pages(bot.prefix + "pulls?state=open"))
        merged = list(completion.recent()) if event_name in {"schedule", "workflow_dispatch"} else []
    if event_name == "workflow_run":
        trigger = event["workflow_run"]
        if trigger.get("event") != "pull_request" or trigger.get("path") != CI_PATH:
            return 0
        prs = [pr for pr in prs if run_matches(pr, trigger, github.repository)]
    errors = 0
    for pr in prs:
        number = pr["number"]
        try:
            result = bot.process(number, dry_run)
        except Exception as error:
            errors += 1
            result = f"ERROR: {type(error).__name__}; merge or issue completion requires a retry"
            try:
                bot.comment(number, ["GitHub API or policy verification failed. The bot will retry; a maintainer should inspect the Automatic PR merge workflow if this persists."], dry_run)
            except Exception:
                result += "; comment API also unavailable"
        print(f"PR {number}: {safe_text(result)}", flush=True)
    for pr in merged:
        try:
            result = completion.process(pr["number"], dry_run)
        except Exception as error:
            errors += 1
            result = f"ERROR: {type(error).__name__}; issue completion will retry"
        print(f"PR {pr['number']} issues: {safe_text(result)}", flush=True)
    return int(bool(errors))


if __name__ == "__main__":
    sys.exit(main())
