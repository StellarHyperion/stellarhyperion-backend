"""Inspect immutable GitHub PR differences as data; never check out PR code."""

import base64
import json
import os
import re
from urllib.parse import quote

CONTEXT = "PR safety"
STATUS_AUTHOR = "github-actions[bot]"
SHA = re.compile(r"[0-9a-f]{40}")
MAX_FILES = 300
MAX_MANIFEST_BYTES = 128 * 1024
MAX_PATCH_BYTES = 256 * 1024
HUNK = re.compile(r"@@ -[0-9]+(?:,([0-9]+))? \+[0-9]+(?:,([0-9]+))? @@(?: .*)?")
WIDE_GAP = re.compile(r"(?:^|\S)[^\S\r\n]{80,}\S")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]")
AUTORUN_DIRS = {".github", ".vscode", ".idea", ".devcontainer", ".zed", ".husky", ".githooks"}
REVIEW_FILENAMES = {
    "agent.md", "agents.md", "codeowners", ".gitleaksignore", ".gitattributes", ".gitmodules",
    ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "init", "init.sh", "direnv.toml",
    "sitecustomize.py", "usercustomize.py", ".pre-commit-config.yaml",
}
OPAQUE_ASSETS = {"avif", "gif", "ico", "jpeg", "jpg", "png", "webp", "woff", "woff2"}


def revision(pr):
    base, head = pr["base"]["sha"], pr["head"]["sha"]
    if not all(isinstance(sha, str) and SHA.fullmatch(sha) for sha in (base, head)):
        raise ValueError("Invalid PR revision")
    return base, head


def snapshot(pr):
    return pr["state"], pr["base"]["ref"], pr["base"]["repo"]["full_name"], *revision(pr)


def compare(github, pr):
    base, head = revision(pr)
    return github.request(f"repos/{github.repository}/compare/{base}...{head}?per_page=1")


def path_parts(path):
    if not isinstance(path, str) or any(part in {"", ".", ".."} for part in path.split("/")):
        raise ValueError("Invalid changed-file path")
    return path.casefold().split("/")


def display(path):
    return "".join(char if char in " /._-" or char.isascii() and char.isalnum()
                   else f"\\u{ord(char):04x}" for char in path[:180])


def requires_review(path):
    *directories, name = path_parts(path)
    return (any(directory in AUTORUN_DIRS for directory in directories)
            or name in REVIEW_FILENAMES or name.startswith(("eslint.config.", ".eslintrc"))
            or name.endswith(".code-workspace")
            or CONTROL.search(path) is not None)


def added_lines(file):
    patch = file.get("patch")
    additions, deletions = file["additions"], file["deletions"]
    if not all(type(count) is int and count >= 0 for count in (additions, deletions)):
        raise ValueError("Invalid patch line counts")
    if (patch is None and additions == deletions == 0
            and file["filename"].casefold().rsplit(".", 1)[-1] in OPAQUE_ASSETS):
        return []
    if not isinstance(patch, str) or len(patch) > MAX_PATCH_BYTES or not patch.startswith("@@ "):
        raise ValueError("No complete text patch available")
    result, removed, old_left, new_left = [], 0, 0, 0
    for number, line in enumerate(patch.removesuffix("\n").split("\n")):
        if line.startswith("@@ ") and old_left == new_left == 0:
            match = HUNK.fullmatch(line)
            if match is None:
                raise ValueError("Invalid patch hunk")
            old_left, new_left = (int(count) if count is not None else 1 for count in match.groups())
        elif line == r"\ No newline at end of file" and number:
            continue
        elif line.startswith("+") and new_left:
            new_left -= 1
            result.append(line[1:].removesuffix("\r"))
        elif line.startswith("-") and old_left:
            old_left -= 1
            removed += 1
        elif line.startswith(" ") and old_left and new_left:
            old_left -= 1
            new_left -= 1
        else:
            raise ValueError("Incomplete text patch")
    if old_left or new_left or len(result) != additions or removed != deletions:
        raise ValueError("Incomplete text patch")
    return result


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate manifest key")
        result[key] = value
    return result


def scripts_at(github, path, ref, blob=None):
    content = github.request(f"repos/{github.repository}/contents/{quote(path)}?ref={ref}")
    if (content.get("type") != "file" or content.get("encoding") != "base64"
            or (blob is not None and content.get("sha") != blob)):
        raise ValueError("Manifest is not the expected regular file")
    encoded = content["content"].replace("\n", "")
    if len(encoded) > 4 * ((MAX_MANIFEST_BYTES + 2) // 3):
        raise ValueError("Manifest exceeds scan limit")
    data = json.loads(base64.b64decode(encoded, validate=True), object_pairs_hook=unique_json)
    scripts = data.get("scripts", {}) if isinstance(data, dict) else None
    if not isinstance(scripts, dict) or not all(isinstance(command, str) for command in scripts.values()):
        raise ValueError("Invalid package scripts")
    return scripts


def findings(github, pr, comparison):
    base, head = revision(pr)
    merge_base = comparison["merge_base_commit"]["sha"]
    files = comparison["files"]
    if (comparison["base_commit"]["sha"] != base or not isinstance(merge_base, str)
            or not SHA.fullmatch(merge_base) or not isinstance(files, list) or len(files) >= MAX_FILES
            or type(pr.get("changed_files")) is not int or len(files) != pr["changed_files"]):
        raise ValueError("GitHub did not return the complete immutable changed-file list")
    issues = []
    seen = set()
    for file in files:
        path, status = file["filename"], file["status"]
        parts = path_parts(path)
        old_path = file.get("previous_filename", path)
        if path in seen or status not in {"added", "modified", "removed", "renamed", "copied", "changed"}:
            raise ValueError("Ambiguous changed-file metadata")
        if status in {"renamed", "copied"} and old_path == path:
            raise ValueError("Missing original changed-file path")
        seen.add(path)
        if requires_review(path) or requires_review(old_path):
            issues.append(f"{display(path)}: editor, startup, or security-policy path requires maintainer review")
            continue
        if status == "removed":
            continue
        try:
            lines = added_lines(file)
        except ValueError:
            issues.append(f"{display(path)}: no complete inspectable text patch")
            continue
        if any(len(line) > 4096 or CONTROL.search(line) or WIDE_GAP.search(line.expandtabs(8)) for line in lines):
            issues.append(f"{display(path)}: hidden characters, extreme line length, or code after a wide gap")
        if parts[-1] == "package.json":
            if not isinstance(file.get("sha"), str) or not SHA.fullmatch(file["sha"]):
                raise ValueError("Invalid manifest revision")
            before = {} if status == "added" else scripts_at(github, old_path, merge_base)
            after = scripts_at(github, path, head, file["sha"])
            if before != after:
                issues.append(f"{display(path)}: package scripts changed; inspect before any npm commands run")
    return issues


class Safety:
    def __init__(self, github):
        self.github = github

    def report(self, pr, endpoint):
        expected = snapshot(pr)
        base, head = revision(pr)
        prefix = f"repos/{self.github.repository}/"
        try:
            issues = findings(self.github, pr, compare(self.github, pr))
            state = "failure" if issues else "success"
        except (KeyError, OSError, RuntimeError, TypeError, ValueError) as error:
            state, issues = "error", [f"Could not verify the complete PR diff ({type(error).__name__})"]
        states = {
            "success": "Changed files passed trusted PR safety checks",
            "failure": "Potential unsafe changes: review the safety log before checking out",
            "error": "PR safety scan incomplete; automatic CI approval is blocked",
        }
        description = f"{states[state]} (base {base})"
        statuses = self.github.pages(prefix + f"commits/{head}/statuses")
        previous = next((status for status in statuses if status.get("context") == CONTEXT), {})
        if snapshot(self.github.request(endpoint)) != expected:
            return "changed", []
        if (previous.get("state") != state or previous.get("description") != description
                or (previous.get("creator") or {}).get("login") != STATUS_AUTHOR):
            url = f"https://github.com/{self.github.repository}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
            self.github.request(prefix + f"statuses/{head}", "POST", {
                "context": CONTEXT, "state": state, "description": description, "target_url": url,
            })
        if len(issues) > 20:
            issues = issues[:20] + ["Additional paths require review; inspect the complete diff in GitHub"]
        return state, issues
