"""Check human PR descriptions against the template at their trusted base commit."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys

DEPENDENCY_BOTS = {"dependabot[bot]", "renovate[bot]"}
HEADING = re.compile(r"^ {0,3}##\s+(.+?)\s*#*\s*$")
CHECKBOX = re.compile(r"^\s*[-*]\s+\[([ xX])\]\s+(.+)$", re.MULTILINE)
BARE_PLACEHOLDER = re.compile(r"(?:n/?a|not applicable|none|todo|tbd|\.\.\.)[.!]?", re.IGNORECASE)


def visible_markdown(text):
    text = re.sub(r"<!--.*?(?:-->|\Z)", "", text or "", flags=re.DOTALL)
    lines = []
    fence = None
    for line in text.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            value = marker[1]
            if fence is None:
                fence = value
            elif value[0] == fence[0] and len(value) >= len(fence):
                fence = None
            continue
        if fence is None:
            lines.append(line)
    return "\n".join(lines)


def sections(text):
    parsed = []
    for line in visible_markdown(text).splitlines():
        match = HEADING.match(line)
        if match:
            parsed.append([match[1].strip(), []])
        elif parsed:
            parsed[-1][1].append(line)
    return [(name, "\n".join(lines).strip()) for name, lines in parsed]


def choice_key(text):
    return " ".join(text.replace("`", "").casefold().split())


def validate_description(body, template):
    expected = sections(template)
    if not expected:
        raise ValueError("Established PR template has no required sections")
    actual = sections(body)
    names = [name.casefold() for name, _ in actual]
    errors = []
    previous = -1
    for heading, template_body in expected:
        key = heading.casefold()
        if names.count(key) != 1:
            errors.append(f"Include exactly one '## {heading}' section.")
            continue
        index = names.index(key)
        if index < previous:
            errors.append(f"Keep '## {heading}' in the template's section order.")
        previous = index
        content = actual[index][1].strip()
        if not content or BARE_PLACEHOLDER.fullmatch(content) or not re.search(r"[A-Za-z0-9]", content):
            errors.append(f"Answer '## {heading}'; explain why if it is not applicable.")
            continue
        template_choices = CHECKBOX.findall(template_body)
        not_applicable = re.search(r"\b(?:not applicable|n/a)\b\s*[:;,.-]?\s+\S.+", content, re.IGNORECASE)
        if template_choices and not not_applicable:
            choices = CHECKBOX.findall(content)
            keys = {choice_key(text) for _, text in choices}
            if any(choice_key(text) not in keys for _, text in template_choices):
                errors.append(f"Keep the established checklist items in '## {heading}'.")
            if not any(mark.lower() == "x" for mark, _ in choices):
                errors.append(f"Select an applicable checklist item in '## {heading}', or explain why it is not applicable.")
        if re.search(r"^\s*(?:[-*]\s*)?(?:TODO|TBD)\b(?:\s*:|\s*$)", content, re.IGNORECASE | re.MULTILINE):
            errors.append(f"Replace TODO/TBD placeholders in '## {heading}'.")
    return errors


def main(event_name, event):
    if event_name != "pull_request":
        print("PR description check is not applicable to this non-PR run.")
        return 0
    pr = event.get("pull_request")
    if not isinstance(pr, dict):
        raise ValueError("Missing PR metadata")
    user = pr.get("user", {})
    if user.get("type") == "Bot" and user.get("login", "").lower() in DEPENDENCY_BOTS:
        print("Authenticated dependency bot is exempt from description formatting; security checks remain required.")
        return 0
    base_sha = pr.get("base", {}).get("sha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", base_sha):
        raise ValueError("Invalid trusted PR base commit")
    result = subprocess.run(["git", "show", base_sha + ":.github/pull_request_template.md"],
                            capture_output=True, text=True, check=True)
    errors = validate_description(pr.get("body"), result.stdout)
    for error in errors:
        print("::error::" + error)
    print("PR description matches the established template." if not errors else
          f"PR description has {len(errors)} template requirement(s) to address.")
    return int(bool(errors))


if __name__ == "__main__":
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
        sys.exit(main(os.environ["GITHUB_EVENT_NAME"], event))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
