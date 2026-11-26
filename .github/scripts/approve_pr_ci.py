"""Approve waiting fork CI for contributors authorized by the assignment policy.

This control-plane script runs from the default branch without checking out any
PR code. Approval starts the ordinary read-only, secret-free pull_request jobs;
it never approves a code review, merges a PR, or changes a check result.
"""

import os
import json
from datetime import datetime
import re
import sys
import time
from pathlib import Path

from enforce_pr_assignments import Enforcement, GitHub
from pr_safety import Safety, snapshot

CI_PATH = ".github/workflows/dev-ci.yml"
SHA = re.compile(r"[0-9a-f]{40}")


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Invalid workflow event timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Workflow event timestamp must have a timezone")
    return parsed


def waiting(run):
    return run.get("conclusion") == "action_required" or run.get("status") == "action_required"


def newest_run(runs):
    for run in runs:
        if type(run.get("id")) is not int or run["id"] <= 0:
            raise ValueError("Invalid workflow run id")
    return max(runs, key=lambda run: run["id"]) if runs else None


def authorization_state(pr):
    head, base, user = pr.get("head", {}), pr.get("base", {}), pr.get("user", {})
    fork, target = head.get("repo") or {}, base.get("repo") or {}
    return (pr.get("state"), pr.get("title"), pr.get("body"), pr.get("author_association"),
            user.get("login"), user.get("type"), head.get("sha"), head.get("ref"),
            fork.get("id"), fork.get("full_name"), base.get("ref"), target.get("full_name"))


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
    def __init__(self, github, policy, safety):
        self.github = github
        self.policy = policy
        self.safety = safety

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

    def approve(self, number, registration_attempts=1, sleep=time.sleep, not_before=None):
        if type(number) is not int or number <= 0:
            raise ValueError("Invalid PR number")
        endpoint = f"repos/{self.github.repository}/pulls/{number}"
        pr = self.github.request(endpoint)
        if pr["state"] != "open":
            return ["SKIP: pull request is closed"]
        if pr["base"]["ref"] != self.github.policy_ref:
            return ["SKIP: pull request does not target dev"]
        scanned = snapshot(pr)
        verdict, findings = self.safety.report(pr, endpoint)
        if verdict == "changed":
            return ["WAIT: PR changed during safety verification; the recovery sweep will retry"]
        if verdict == "error":
            return ["ERROR: " + finding for finding in findings]
        if verdict != "success":
            return ["BLOCK: " + finding for finding in findings]
        # The trusted PR event can arrive before GitHub registers the ordinary CI run.
        # Retry only registration, always fetching fresh PR state and assignments.
        for attempt in range(registration_attempts):
            runs = [run for run in self.runs(pr["head"]["sha"])
                    if matches(pr, run, self.github.repository, self.github.policy_ref)
                    and (not_before is None or timestamp(run.get("created_at")) >= not_before)]
            # Approving an older description snapshot after the newest run can cancel the
            # correct run through the CI concurrency group. Only the newest matching run
            # can be authorized, including during scheduled recovery sweeps.
            newest = newest_run(runs)
            candidates = [newest] if newest is not None and waiting(newest) else []
            if runs or attempt == registration_attempts - 1:
                break
            allowed, reason = self.policy.decision(pr)
            if not allowed:
                return ["WAIT: " + reason]
            sleep(5)
            pr = self.github.request(endpoint)
            if pr["state"] != "open":
                return ["SKIP: pull request is closed"]
            if snapshot(pr) != scanned:
                return ["SKIP: PR revision changed; the recovery sweep will scan it"]
        if not candidates:
            return ["SKIP: current CI already started" if runs else
                    "WAIT: current CI has not registered; the recovery sweep will retry"]
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
            if (snapshot(current) != scanned or not waiting(run)
                    or not matches(current, run, self.github.repository, self.github.policy_ref)):
                rows.append(f"SKIP run {run_id}: run or PR head changed")
                continue
            # Recheck every issue assignment immediately before approval, then the PR head
            # again: assignments and PR text/head can change while issue APIs are read.
            allowed, reason = self.policy.decision(current)
            if not allowed:
                rows.append(f"WAIT run {run_id}: " + reason)
                continue
            latest = self.github.request(endpoint)
            if (authorization_state(latest) != authorization_state(current)
                    or snapshot(latest) != scanned
                    or not matches(latest, run, self.github.repository, self.github.policy_ref)):
                rows.append(f"SKIP run {run_id}: PR changed during assignment verification")
                continue
            current_runs = [item for item in self.runs(latest["head"]["sha"])
                            if matches(latest, item, self.github.repository, self.github.policy_ref)]
            newest = newest_run(current_runs)
            if newest is None or newest["id"] != run_id:
                rows.append(f"SKIP run {run_id}: a newer matching CI run registered")
                continue
            self.github.request(f"repos/{self.github.repository}/actions/runs/{run_id}/approve", "POST")
            rows.append(f"APPROVE run {run_id}: " + reason)
        return rows


def event_number(event_name, event):
    if event_name != "pull_request_target":
        return None
    number = event.get("number")
    if type(number) is not int or number <= 0:
        raise ValueError("Invalid trusted PR event number")
    return number


def main():
    github = GitHub(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ["POLICY_REF"])
    policy = Enforcement(github, os.environ.get("PR_ASSIGNMENT_HELPER_BOTS", ""))
    approval = Approval(github, policy, Safety(github))
    event_name = os.environ.get("GITHUB_EVENT_NAME", "")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()) if event_name == "pull_request_target" else {}
    number = event_number(event_name, event)
    not_before = timestamp(event.get("pull_request", {}).get("updated_at")) if number is not None else None
    numbers = [number] if number is not None else [pr["number"] for pr in github.pages(f"repos/{github.repository}/pulls?state=open")]
    rows = []
    errors = 0
    for number in numbers:
        try:
            results = approval.approve(number, registration_attempts=12 if event_name == "pull_request_target" else 1,
                                       not_before=not_before)
        except Exception as error:
            results = ["ERROR: " + type(error).__name__ + "; CI was not approved"]
        errors += any(result.startswith("ERROR:") for result in results)
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
