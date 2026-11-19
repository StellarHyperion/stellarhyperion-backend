"""Exercise template omissions, hidden placeholders and authenticated bot exemptions."""

from pathlib import Path
import unittest
from unittest.mock import patch

import check_pr_description as checker

TEMPLATE = "## What changed\n<!-- Explain. -->\n## Why\n\n## Verification\n- [ ] Tests\n"
VALID = "## What changed\nPreserve queued work after retries.\n## Why\nA restart previously lost the retry owner.\n## Verification\n- [x] Tests\n"


class DescriptionTests(unittest.TestCase):
    def test_complete_description_passes(self):
        self.assertEqual(checker.validate_description(VALID, TEMPLATE), [])

    def test_unfilled_template_does_not_pass(self):
        self.assertTrue(checker.validate_description(TEMPLATE, TEMPLATE))

    def test_missing_duplicate_and_reordered_sections_fail(self):
        for body in [VALID.replace("## Why", "## Other"), VALID + "\n## Why\nRepeated.",
                     "## Why\nReason.\n## What changed\nChange.\n## Verification\n- [x] Tests"]:
            with self.subTest(body=body):
                self.assertTrue(checker.validate_description(body, TEMPLATE))

    def test_comment_and_code_example_cannot_supply_missing_section(self):
        for hidden in ["<!-- ## Why\nReason. -->", "```md\n## Why\nReason.\n```"]:
            body = VALID.replace("## Why\nA restart previously lost the retry owner.", hidden)
            self.assertTrue(checker.validate_description(body, TEMPLATE))

    def test_not_applicable_requires_an_explanation(self):
        prefix = "## What changed\nChange.\n## Why\nReason.\n## Verification\n"
        self.assertTrue(checker.validate_description(prefix + "not applicable", TEMPLATE))
        self.assertEqual(checker.validate_description(prefix + "Not applicable: this is a documentation-only change.", TEMPLATE), [])

    def test_unchecked_checklist_requires_an_explicit_explanation(self):
        self.assertTrue(checker.validate_description(VALID.replace("[x]", "[ ]"), TEMPLATE))

    def test_invented_checklist_item_cannot_replace_established_checks(self):
        self.assertTrue(checker.validate_description(VALID.replace("[x] Tests", "[x] Unrelated assertion"), TEMPLATE))

    def test_placeholder_lines_fail_but_describing_placeholder_removal_is_valid(self):
        self.assertTrue(checker.validate_description(VALID.replace("Preserve queued work after retries.", "TODO: explain change"), TEMPLATE))
        self.assertEqual(checker.validate_description(VALID.replace("Preserve queued work after retries.", "Remove the TODO marker after implementing durable retries."), TEMPLATE), [])

    def test_actual_repository_template_requires_contributor_answers(self):
        template = (Path(__file__).resolve().parents[1] / "pull_request_template.md").read_text()
        self.assertTrue(checker.validate_description(template, template))
        body = "\n\n".join("## " + name + "\nNot applicable: policy-only changes do not affect this subsystem."
                             for name, _ in checker.sections(template))
        self.assertEqual(checker.validate_description(body, template), [])

    def test_only_authenticated_dependency_bots_are_exempt(self):
        for login in ("dependabot[bot]", "renovate[bot]"):
            with patch.object(checker.subprocess, "run") as run:
                self.assertEqual(checker.main("pull_request", {"pull_request": {"user": {"login": login, "type": "Bot"}}}), 0)
                run.assert_not_called()
                with self.assertRaises(ValueError):
                    checker.main("pull_request", {"pull_request": {"user": {"login": login, "type": "User"}}})

    def test_non_pr_run_is_exempt_but_missing_pr_metadata_fails_closed(self):
        self.assertEqual(checker.main("push", {}), 0)
        with self.assertRaises(ValueError):
            checker.main("pull_request", {})


if __name__ == "__main__":
    unittest.main()
