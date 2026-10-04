#!/usr/bin/env python3
"""公式境界の失敗、既存設定の保持、未認証の判定を検証する。"""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
loader = importlib.machinery.SourceFileLoader("onepassword_setup", str(ROOT / "bin/setup-1password.sh"))
spec = importlib.util.spec_from_loader(loader.name, loader)
setup = importlib.util.module_from_spec(spec)
loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        # runnerの実HOME向けoverrideを隔離fixtureへ持ち込まない。
        environment = {key: value for key, value in os.environ.items()
                       if key not in {"CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_HOME"}}
        self.environment = patch.dict(os.environ, environment, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_cursorの別MCPと個人設定を保持し登録を読戻す(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            paths = setup.config_paths(home)
            paths["cursor"].parent.mkdir()
            paths["cursor"].write_text(json.dumps({"mcpServers": {"other": {"url": "https://example.invalid"}}, "keep": 7}))
            calls = []

            def official_cli(argv, **kwargs):
                calls.append(argv)
                name = Path(argv[0]).name
                if name == "claude":
                    paths[name].write_text(json.dumps({"mcpServers": {"onepassword": {"command": "/official/mcp", "args": []}}}))
                elif name in ("codex", "grok"):
                    paths[name].parent.mkdir(exist_ok=True)
                    paths[name].write_text('[mcp_servers.onepassword]\ncommand = "/official/mcp"\nargs = []\n')
                return ""

            with patch.object(setup, "executable", side_effect=lambda name: name), patch.object(setup, "run", side_effect=official_cli):
                result = setup.register(home, "/official/mcp")
                count = len(calls)
                second = setup.register(home, "/official/mcp")
            observed = json.loads(paths["cursor"].read_text())
            self.assertEqual(observed["keep"], 7)
            self.assertEqual(observed["mcpServers"]["other"]["url"], "https://example.invalid")
            self.assertEqual(set(result["harnesses"]), {"claude", "codex", "grok", "cursor"})
            self.assertTrue(Path(result["backup"]).is_file())
            self.assertEqual(second["changed"], [])
            self.assertEqual(len(calls), count + 1)
            self.assertEqual(calls[-1], ["cursor-agent", "mcp", "enable", "onepassword"])

    def test_別の1password設定を黙って置き換えない(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            path = home / ".claude.json"
            original = '{"mcpServers":{"onepassword":{"command":"another-server"}}}'
            path.write_text(original)
            with patch.object(setup, "executable", side_effect=lambda name: name), patch.object(setup, "run") as run:
                with self.assertRaisesRegex(setup.SetupError, "registration_conflict"):
                    setup.register(home, "/official/mcp")
            run.assert_not_called()
            self.assertEqual(path.read_text(), original)

    def test_公開CLIが登録を書かなければ成功にしない(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(setup, "executable", side_effect=lambda name: name), patch.object(setup, "run", return_value=""):
                with self.assertRaisesRegex(setup.SetupError, "registration_readback_failed"):
                    setup.register(Path(directory), "/official/mcp")

    def test_旧登録名を移行して別のMCPを保持する(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            paths = setup.config_paths(home)
            paths["cursor"].parent.mkdir()
            paths["cursor"].write_text(json.dumps({"mcpServers": {
                "1password": {"command": "/official/mcp", "args": []},
                "other": {"command": "keep"}}}))
            for name in ("claude", "codex", "grok"):
                path = paths[name]
                path.parent.mkdir(parents=True, exist_ok=True)
                if name == "claude":
                    path.write_text('{"mcpServers":{"onepassword":{"command":"/official/mcp"}}}')
                else:
                    path.write_text('[mcp_servers.onepassword]\ncommand="/official/mcp"\n')
            with patch.object(setup, "executable", side_effect=lambda name: name), patch.object(setup, "run", return_value=""):
                result = setup.register(home, "/official/mcp")
            servers = json.loads(paths["cursor"].read_text())["mcpServers"]
            self.assertNotIn("1password", servers)
            self.assertEqual(servers["other"]["command"], "keep")
            self.assertEqual(result["changed"], ["cursor"])

    def test_ヘッドレスはdesktopMCPを登録しない(self):
        self.assertIsNone(setup.mcp_command("server"))

    def test_未認証は導入済みでも成功にしない(self):
        def cli(argv, **kwargs):
            if "--version" in argv:
                return "2.40.0\n"
            raise setup.SetupError("command_failed: account is not signed in")

        output = io.StringIO()
        with patch.object(setup.sys, "platform", "linux"), patch.object(setup.sys, "argv", ["setup", "--profile", "server"]), \
                patch.object(setup, "install"), patch.object(setup, "executable", return_value="op"), \
                patch.object(setup, "run", side_effect=cli), contextlib.redirect_stdout(output):
            self.assertEqual(setup.main(), 3)
        self.assertFalse(json.loads(output.getvalue())["cli_authenticated"])

    def test_MCPの接続終了を成功にしない(self):
        import queue
        client = setup.MCP.__new__(setup.MCP)
        client.next_id = 0
        client.messages = queue.Queue()
        client.messages.put(None)
        client.send = lambda message: None
        with self.assertRaisesRegex(setup.SetupError, "mcp_closed"):
            client.call("initialize", {})

    def test_CLI認証済みでもMCP未認証を使用可能にしない(self):
        output = io.StringIO()
        with patch.object(setup.sys, "platform", "darwin"), \
                patch.object(setup.sys, "argv", ["setup", "--profile", "mac", "--configure-only"]), \
                patch.object(setup, "install"), patch.object(setup, "executable", side_effect=lambda name: name), \
                patch.object(setup, "mcp_command", return_value="mcp"), patch.object(setup, "register", return_value={}), \
                patch.object(setup, "mcp_probe", return_value={"protocol_verified": True, "authenticated": False}), \
                patch.object(setup, "run", return_value="{}"), contextlib.redirect_stdout(output):
            self.assertEqual(setup.main(), 3)
        self.assertFalse(json.loads(output.getvalue())["ready"])

    def test_UTF8の外部CLI結果をWindowsでも破損させない(self):
        completed = setup.subprocess.CompletedProcess(["op"], 0, "認証済み", "")
        with patch.object(setup.subprocess, "run", return_value=completed) as process:
            self.assertEqual(setup.run(["op", "whoami"]), "認証済み")
        self.assertEqual(process.call_args.kwargs["encoding"], "utf-8")

    def test_サーバーprofileはxtraceへtokenを出さない(self):
        if setup.sys.platform == "win32":
            self.skipTest("Linux認証アダプタはPOSIX shellで検証する")
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            binary = home / "systemd-creds"
            binary.write_text("#!/bin/sh\nprintf '%s' 'unit-test-secret-value'\n")
            binary.chmod(0o700)
            profile = home / "profile.sh"
            profile.write_text(setup.SERVER_PROFILE)
            process = setup.subprocess.run(["bash", "-xc", '. "$HOME/profile.sh"; test "${#OP_SERVICE_ACCOUNT_TOKEN}" -gt 0'],
                                           env={**os.environ, "HOME": str(home), "PATH": str(home) + os.pathsep + os.environ["PATH"]},
                                           capture_output=True, text=True)
            self.assertEqual(process.returncode, 0)
            self.assertNotIn("unit-test-secret-value", process.stdout + process.stderr)

    def test_サーバーtokenをSSHのargvへ載せない(self):
        calls = []
        secret = "unit-test-service-account-token"

        def official(argv, **kwargs):
            calls.append((argv, kwargs))
            if argv[:3] == ["op", "item", "list"]:
                return '[{"id":"stored-service-account"}]'
            if argv[:3] == ["op", "item", "get"]:
                return secret
            if argv[0] == "ssh":
                return '{"server_authenticated":true}'
            self.fail(f"想定外の公開コマンド: {argv}")

        with patch.object(setup, "run", side_effect=official):
            self.assertTrue(setup.provision_server("main-server")["server_authenticated"])
        self.assertTrue(all(secret not in " ".join(argv) for argv, _ in calls))
        self.assertEqual(calls[-1][1]["input"], secret)

    def test_秘密を扱うCLIの失敗出力をエラーへ含めない(self):
        secret = "unit-test-secret-output"
        completed = setup.subprocess.CompletedProcess(["op"], 1, secret, secret)
        with patch.object(setup.subprocess, "run", return_value=completed):
            with self.assertRaises(setup.SetupError) as error:
                setup.run(["op", "service-account", "create", "--raw"], sensitive=True)
        self.assertNotIn(secret, str(error.exception))
        self.assertIn("exit 1", str(error.exception))

    @unittest.skipUnless(setup.sys.platform == "win32", "Windows nativeの正規入口はWindowsで実行する")
    def test_Windows正規入口からPythonのヘルプへ到達する(self):
        process = setup.subprocess.run(["pwsh", "-NoProfile", "-File", str(ROOT / "bin/setup-1password.ps1"), "--help"],
                                       capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn("--profile", process.stdout)
        self.assertIn("公式1Password", process.stdout)


if __name__ == "__main__":
    unittest.main()
