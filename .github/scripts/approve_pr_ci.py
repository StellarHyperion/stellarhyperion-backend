"""Approve waiting fork CI for contributors authorized by the assignment policy.

This control-plane script runs from the default branch without checking out any
PR code. Approval starts the ordinary read-only, secret-free pull_request jobs;
it never approves a code review, merges a PR, or changes a check result.
"""

import os
import re
import sys
from pathlib import Path

from enforce_pr_assignments import Enforcement, GitHub

CI_PATH = ".github/workflows/ci.yml"
SHA = re.compile(r"[0-9a-f]{40}")


def waiting(run):
    return run.get("conclusion") == "action_required" or run.get("status") == "action_required"


def matches(pr, run, repository, default_branch):
    head = pr.get("head", {})
    base = pr.get("base", {})
    fork = head.get("repo") or {}
    run_fork = run.get("head_repository") or {}
    sha = head.get("sha")
    branch = head.get("ref")
    fork_name = fork.get("full_name")
    run_name = run_fork.get("full_name")
    return (
        pr.get("state") == "open"
        and base.get("ref") == default_branch
        and base.get("repo", {}).get("full_name", "").lower() == repository.lower()
        and isinstance(sha, str) and SHA.fullmatch(sha) is not None
        and run.get("event") == "pull_request"
        and run.get("path") == CI_PATH
        and run.get("repository", {}).get("full_name", "").lower() == repository.lower()
        and run.get("head_sha") == sha
        and isinstance(branch, str) and bool(branch)
        and run.get("head_branch") == branch
        and type(fork.get("id")) is int and fork["id"] > 0
        and type(run_fork.get("id")) is int
        and isinstance(fork_name, str) and bool(fork_name)
        and isinstance(run_name, str) and bool(run_name)
        and fork.get("id") == run_fork.get("id")
        and fork.get("full_name", "").lower() == run_fork.get("full_name", "").lower()
        and fork.get("full_name", "").lower() != repository.lower()
    )


class Approval:
    def __init__(self, github, policy):
        self.github = github
        self.policy = policy

    def runs(self, sha):
        if not isinstance(sha, str) or SHA.fullmatch(sha) is None:
            raise ValueError("Invalid current PR head")
        runs = []
        for page in range(1, 11):
            response = self.github.request(
                f"repos/{self.github.repository}/actions/runs?event=pull_request"
                f"&head_sha={sha}&per_page=100&page={page}"
            )
            batch = response.get("workflow_runs")
            if not isinstance(batch, list):
                raise RuntimeError("GitHub did not return workflow runs")
            runs.extend(batch)
            if len(batch) < 100:
                return runs
        raise RuntimeError("CI run pagination exceeded its limit")

    def approve(self, number):
        if type(number) is not int or number <= 0:
            raise ValueError("Invalid PR number")
        endpoint = f"repos/{self.github.repository}/pulls/{number}"
        pr = self.github.request(endpoint)
        if pr["state"] != "open":
            return ["SKIP: pull request is closed"]
        candidates = [run for run in self.runs(pr["head"]["sha"])
                      if waiting(run) and matches(pr, run, self.github.repository, self.github.policy_ref)]
        if not candidates:
            return ["SKIP: no current CI run requires approval"]
        allowed, reason = self.policy.decision(pr)
        if not allowed:
            return ["WAIT: " + reason]
        rows = []
        for candidate in candidates:
            run_id = candidate.get("id")
            if type(run_id) is not int or run_id <= 0:
                raise ValueError("Invalid workflow run id")
            run = self.github.request(f"repos/{self.github.repository}/actions/runs/{run_id}")
            current = self.github.request(endpoint)
            if not waiting(run) or not matches(current, run, self.github.repository, self.github.policy_ref):
                rows.append(f"SKIP run {run_id}: run or PR head changed")
                continue
            # Recheck every issue assignment immediately before approval.
            allowed, reason = self.policy.decision(current)
            if not allowed:
                rows.append(f"WAIT run {run_id}: " + reason)
                continue
            self.github.request(f"repos/{self.github.repository}/actions/runs/{run_id}/approve", "POST")
            rows.append(f"APPROVE run {run_id}: " + reason)
        return rows


def main():
    github = GitHub(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ["POLICY_REF"])
    policy = Enforcement(github, os.environ.get("PR_ASSIGNMENT_HELPER_BOTS", ""))
    approval = Approval(github, policy)
    numbers = [pr["number"] for pr in github.pages(f"repos/{github.repository}/pulls?state=open")]
    rows = []
    errors = 0
    for number in numbers:
        try:
            results = approval.approve(number)
        except Exception as error:
            results = ["ERROR: " + type(error).__name__ + "; CI was not approved"]
            errors += 1
        for result in results:
            line = f"PR {number}: {result}"
            print(line, flush=True)
            rows.append(line)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a") as output:
            output.write("Automatic PR CI authorization\n\n" + "\n".join("- " + row for row in rows) + "\n")
    return int(errors > 0)


if __name__ == "__main__":
    sys.exit(main())
