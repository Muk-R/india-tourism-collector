import os
import unittest
from unittest.mock import patch

from scripts import run_batch, seed_cities


class CredentialPromptTests(unittest.TestCase):
    def test_batch_uses_environment_token_without_prompting(self):
        with patch.dict(os.environ, {"ADMIN_TOKEN": "unit-test-token"}), patch("scripts.run_batch.getpass.getpass") as prompt:
            self.assertIsNotNone(run_batch.resolve_admin_token())
            prompt.assert_not_called()

    def test_batch_does_not_prompt_without_interactive_terminal(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.stdin") as stdin, patch("sys.stderr") as stderr, patch(
            "scripts.run_batch.getpass.getpass"
        ) as prompt:
            stdin.isatty.return_value = False
            stderr.isatty.return_value = False
            self.assertIsNone(run_batch.resolve_admin_token())
            prompt.assert_not_called()

    def test_batch_prompts_when_terminal_is_interactive(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.stdin") as stdin, patch("sys.stderr") as stderr, patch(
            "scripts.run_batch.getpass.getpass", return_value="unit-test-token"
        ) as prompt:
            stdin.isatty.return_value = True
            stderr.isatty.return_value = True
            self.assertIsNotNone(run_batch.resolve_admin_token())
            prompt.assert_called_once()

    def test_seeder_does_not_prompt_without_interactive_terminal(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.stdin") as stdin, patch("sys.stderr") as stderr, patch(
            "scripts.seed_cities.getpass.getpass"
        ) as prompt:
            stdin.isatty.return_value = False
            stderr.isatty.return_value = False
            self.assertIsNone(seed_cities.resolve_supabase_secret_key())
            prompt.assert_not_called()

    def test_seeder_uses_environment_key_without_prompting(self):
        with patch.dict(os.environ, {"SUPABASE_SECRET_KEY": "unit-test-key"}), patch(
            "scripts.seed_cities.getpass.getpass"
        ) as prompt:
            self.assertIsNotNone(seed_cities.resolve_supabase_secret_key())
            prompt.assert_not_called()

    def test_seeder_prompts_when_terminal_is_interactive(self):
        with patch.dict(os.environ, {}, clear=True), patch("sys.stdin") as stdin, patch("sys.stderr") as stderr, patch(
            "scripts.seed_cities.getpass.getpass", return_value="unit-test-key"
        ) as prompt:
            stdin.isatty.return_value = True
            stderr.isatty.return_value = True
            self.assertIsNotNone(seed_cities.resolve_supabase_secret_key())
            prompt.assert_called_once()


if __name__ == "__main__":
    unittest.main()
