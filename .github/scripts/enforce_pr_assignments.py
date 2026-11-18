"""Reject unassigned contributors without executing pull request code."""

import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TRUSTED_BOTS = {
    "dependabot[bot]",
    "renovate[bot]",
    "github-actions[bot]",
    "copilot-swe-agent[bot]",
    "copilot[bot]",
    "copilot",
    "coderabbitai[bot]",
}
TRUSTED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
REFERENCE = re.compile(
    r"https://github\.com/(?P<url_owner>[\w.-]+)/(?P<url_repo>[\w.-]+)/issues/(?P<url_number>[1-9]\d*)\b"
    r"|(?<![\w/])(?P<owner>[\w.-]+)/(?P<repo>[\w.-]+)#(?P<number>[1-9]\d*)\b"
    r"|(?<![\w/#])#(?P<local_number>[1-9]\d*)\b",
    re.IGNORECASE,
)
LINKS_QUERY = """
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 100, after: $after) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""


def text_references(text, repository):
    """Read real issue mentions; ignore comments and fenced examples."""
    text = re.sub(r"<!--.*?(?:-->|\Z)", "", text or "", flags=re.DOTALL)
    text = re.sub(r"(?m)^\s*(`{3,}|~{3,})[^\n]*\n.*?(?:^\s*\1\s*$|\Z)", "", text, flags=re.DOTALL)
    text = re.sub(
        r"https?://[^\s<>()]+",
        lambda match: match.group(0) if re.match(
            r"https://github\.com/[\w.-]+/[\w.-]+/issues/[1-9]\d*\b",
            match.group(0), re.IGNORECASE,
        ) else " ",
        text,
    )
    refs = set()
    for match in REFERENCE.finditer(text):
        groups = match.groupdict()
        if groups["url_number"]:
            target = groups["url_owner"] + "/" + groups["url_repo"]
            number = groups["url_number"]
        elif groups["number"]:
            target = groups["owner"] + "/" + groups["repo"]
            number = groups["number"]
        else:
            target, number = repository, groups["local_number"]
        refs.add((target.lower(), int(number)))
    return refs


def codeowner_users(text):
    users = set()
    for line in text.splitlines():
        fields = line.split("#", 1)[0].split()
        for field in fields[1:]:
            if re.fullmatch(r"@[\w-]+", field):
                users.add(field[1:].lower())
    return users


class GitHub:
    def __init__(self, token, repository, policy_ref):
        self.token = token
        self.repository = repository
        self.policy_ref = policy_ref

    def request(self, path, method="GET", data=None):
        payload = None if data is None else json.dumps(data).encode()
        for attempt in range(3):
            request = urllib.request.Request(
                "https://api.github.com/" + path.lstrip("/"),
                data=payload,
                method=method,
                headers={
                    "Authorization": "Bearer " + self.token,
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "hyperion-pr-assignment-enforcement",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = response.read()
                    return json.loads(body) if body else None
            except urllib.error.HTTPError as error:
                retry_after = error.headers.get("Retry-After")
                if attempt == 2 or not (error.code >= 500 or error.code == 429 or retry_after):
                    raise
                time.sleep(min(int(retry_after or 2 ** attempt), 30))
        raise RuntimeError("GitHub request exhausted retries")

    def pages(self, path):
        for page in range(1, 1001):
            separator = "&" if "?" in path else "?"
            batch = self.request(f"{path}{separator}per_page=100&page={page}")
            yield from batch
            if len(batch) < 100:
                return
        raise RuntimeError("GitHub pagination limit exceeded")

    def codeowners(self):
        # GitHub searches these locations in this order.
        for location in [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]:
            try:
                content = self.request(
                    f"repos/{self.repository}/contents/{location}?"
                    + urllib.parse.urlencode({"ref": self.policy_ref})
                )
                return codeowner_users(base64.b64decode(content["content"]).decode())
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
        return set()

    def linked_issues(self, number):
        owner, repo = self.repository.split("/", 1)
        after = None
        refs = set()
        while True:
            result = self.request(
                "graphql", "POST",
                {"query": LINKS_QUERY, "variables": {
                    "owner": owner, "repo": repo, "number": number, "after": after,
                }},
            )
            if result.get("errors"):
                raise RuntimeError("GitHub could not verify linked issues")
            connection = result["data"]["repository"]["pullRequest"]["closingIssuesReferences"]
            refs.update((node["repository"]["nameWithOwner"].lower(), node["number"])
                        for node in connection["nodes"])
            if not connection["pageInfo"]["hasNextPage"]:
                return refs
            cursor = connection["pageInfo"]["endCursor"]
            if not cursor or cursor == after:
                raise RuntimeError("Linked issue pagination did not advance")
            after = cursor


class Enforcement:
    def __init__(self, github, extra_bots=""):
        self.github = github
        self.owners = github.codeowners()
        self.bots = TRUSTED_BOTS | {login.strip().lower() for login in extra_bots.split(",") if login.strip()}

    def decision(self, pr):
        author = pr["user"]["login"].lower()
        if author in self.bots:
            # Built-in names must be authenticated GitHub App bots; explicitly
            # configured names may also be maintainer-run service accounts.
            if author not in TRUSTED_BOTS or pr["user"]["type"] == "Bot":
                return True, "trusted helper bot"
        if pr.get("author_association") in TRUSTED_ASSOCIATIONS:
            return True, "organization member or repository collaborator"
        if author in self.owners:
            return True, "code owner on the default branch"
        permission = self.github.request(
            f"repos/{self.github.repository}/collaborators/{urllib.parse.quote(author, safe='')}/permission"
        )
        if permission["permission"] in {"admin", "maintain", "write", "triage"}:
            return True, "repository role"

        refs = text_references((pr.get("title") or "") + "\n" + (pr.get("body") or ""), self.github.repository)
        refs |= self.github.linked_issues(pr["number"])
        organization = self.github.repository.split("/", 1)[0].lower()
        # Outside issues cannot authorize a contribution to this organization.
        refs = {(repo, number) for repo, number in refs if repo.split("/", 1)[0] == organization}
        issues = []
        for repo, number in sorted(refs):
            issue = self.github.request(f"repos/{repo}/issues/{number}")
            if "pull_request" not in issue:
                issues.append((repo, number, issue))
        if not issues:
            return False, "no referenced issue in this organization; request assignment and link the issue"
        unassigned = [f"{repo}#{number}" for repo, number, issue in issues
                      if author not in {user["login"].lower() for user in issue["assignees"]}]
        if unassigned:
            return False, "author is not assigned to " + ", ".join(unassigned)
        return True, "author is assigned to every referenced issue"

    def enforce(self, pr, dry_run=False):
        endpoint = f"repos/{self.github.repository}/pulls/{pr['number']}"
        current = self.github.request(endpoint)
        if current["state"] != "open":
            return "SKIP", "already closed"
        allowed, reason = self.decision(current)
        if allowed:
            return "KEEP", reason
        if dry_run:
            return "WOULD CLOSE", reason
        # Re-evaluate fresh PR text, roles, links, and assignments before mutation.
        current = self.github.request(endpoint)
        if current["state"] != "open":
            return "SKIP", "already closed"
        allowed, reason = self.decision(current)
        if allowed:
            return "KEEP", reason
        closed = self.github.request(endpoint, "PATCH", {"state": "closed"})
        if closed["state"] != "closed" or closed["merged"]:
            raise RuntimeError("PR closure could not be verified")
        return "CLOSE", reason


def main():
    github = GitHub(os.environ["GITHUB_TOKEN"], os.environ["GITHUB_REPOSITORY"], os.environ["POLICY_REF"])
    policy = Enforcement(github, os.environ.get("PR_ASSIGNMENT_HELPER_BOTS", ""))
    dry_run = os.environ.get("DRY_RUN", "false").lower() == "true"
    rows = []
    errors = 0
    # Snapshot all pages before closures change the open-PR list and offsets.
    pull_requests = list(github.pages(f"repos/{github.repository}/pulls?state=open"))
    for pr in pull_requests:
        try:
            status, reason = policy.enforce(pr, dry_run)
        except Exception as error:
            # API failures preserve the PR and fail the run for maintainer review.
            status, reason = "ERROR", type(error).__name__ + ": assignment could not be verified; PR preserved"
            errors += 1
        line = f"PR {pr['number']}: {status} - {reason}"
        print(line, flush=True)
        rows.append(line)
        if status == "CLOSE":
            time.sleep(1.1)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a") as output:
            output.write("PR assignment enforcement\n\n" + "\n".join("- " + row for row in rows) + "\n")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
