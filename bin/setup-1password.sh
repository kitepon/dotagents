#!/usr/bin/env python3
"""公式1Passwordの導入・親別MCP登録・公開疎通を行う。秘密の移行は行わない。"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import queue
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import tomllib


for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")


SERVER_ID = "onepassword"


class SetupError(RuntimeError):
    pass


def run(argv, *, input=None, timeout=120, sensitive=False):
    # Windowsの公式npm/CLI launcherはPowerShell 7から呼ぶ。
    if sys.platform == "win32" and Path(argv[0]).suffix.lower() in {".ps1", ".cmd", ".bat"}:
        command = ("[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);"
                   "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"
                   "$OutputEncoding=[Text.UTF8Encoding]::new($false);& "
                   + " ".join("'" + value.replace("'", "''") + "'" for value in argv))
        encoded = base64.b64encode(command.encode("utf-16le")).decode()
        argv = ["pwsh", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
    result = subprocess.run(argv, input=input, capture_output=True, text=True, encoding="utf-8", timeout=timeout, check=False)
    if result.returncode:
        if sensitive:
            raise SetupError(f"command_failed: {Path(argv[0]).name}: exit {result.returncode}（秘密を含み得る出力は非表示）")
        raise SetupError(f"command_failed: {Path(argv[0]).name}: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def executable(name):
    found = shutil.which(name)
    if not found:
        raise SetupError(f"command_missing: {name}")
    return found


def install(profile):
    desktop = profile != "server"
    if sys.platform == "darwin":
        if not shutil.which("op"):
            run([executable("brew"), "install", "1password-cli"], timeout=600)
        if desktop and not Path("/Applications/1Password.app").exists():
            run([executable("brew"), "install", "--cask", "1password"], timeout=600)
    elif sys.platform == "win32":
        packages = []
        if not shutil.which("op"):
            packages.append("AgileBits.1Password.CLI")
        if desktop and not shutil.which("1password-mcp"):
            packages.append("AgileBits.1Password")
        for package in packages:
            args = [executable("winget"), "install", "--id", package, "--exact", "--source", "winget",
                    "--silent", "--disable-interactivity", "--accept-package-agreements", "--accept-source-agreements"]
            if package == "AgileBits.1Password":
                args += ["--installer-type", "msix"]
            run(args, timeout=600)
        # package managerが追加した標準PATHを現在のprocessへ反映する。
        local = Path(os.environ["LOCALAPPDATA"])
        os.environ["PATH"] += os.pathsep + os.pathsep.join(str(local / p) for p in
                                                        ("Microsoft/WinGet/Links", "Microsoft/WindowsApps"))
    elif sys.platform == "linux":
        packages = []
        if not shutil.which("op"):
            packages.append("1password-cli")
        if desktop and not Path("/opt/1Password/1password-mcp").exists():
            packages.append("1password")
        if not packages:
            return
        executable("apt-get")
        key = "/usr/share/keyrings/1password-archive-keyring.gpg"
        if not Path(key).exists():
            content = run(["curl", "-fsS", "https://downloads.1password.com/linux/keys/1password.asc"])
            run(["sudo", "-n", "gpg", "--dearmor", "--output", key], input=content)
        source = "/etc/apt/sources.list.d/1password.list"
        if not Path(source).exists():
            arch = run(["dpkg", "--print-architecture"]).strip()
            run(["sudo", "-n", "tee", source], input=f"deb [arch={arch} signed-by={key}] https://downloads.1password.com/linux/debian/{arch} stable main\n")
        policy_dir = "/etc/debsig/policies/AC2D62742012EA22"
        key_dir = "/usr/share/debsig/keyrings/AC2D62742012EA22"
        run(["sudo", "-n", "mkdir", "-p", policy_dir, key_dir])
        if not Path(policy_dir, "1password.pol").exists():
            content = run(["curl", "-fsS", "https://downloads.1password.com/linux/debian/debsig/1password.pol"])
            run(["sudo", "-n", "tee", policy_dir + "/1password.pol"], input=content)
        if not Path(key_dir, "debsig.gpg").exists():
            content = run(["curl", "-fsS", "https://downloads.1password.com/linux/keys/1password.asc"])
            run(["sudo", "-n", "gpg", "--dearmor", "--output", key_dir + "/debsig.gpg"], input=content)
        run(["sudo", "-n", "apt-get", "update"], timeout=600)
        run(["sudo", "-n", "apt-get", "install", "-y", *packages], timeout=600)
    else:
        raise SetupError("platform_unsupported: 公式導入入口がありません")


def mcp_command(profile):
    if profile == "server":
        return None
    found = shutil.which("1password-mcp")
    if found:
        return found
    paths = {"darwin": "/Applications/1Password.app/Contents/MacOS/1password-mcp",
             "linux": "/opt/1Password/1password-mcp"}
    candidate = paths.get(sys.platform)
    if candidate and Path(candidate).is_file():
        return candidate
    raise SetupError("mcp_missing: インストール済み公式アプリのMCP入口がありません")


def config_paths(home):
    claude_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    return {
        "claude": Path(claude_dir, ".claude.json") if claude_dir else home / ".claude.json",
        "codex": Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "config.toml",
        "grok": home / ".grok/config.toml",
        "cursor": Path(os.environ.get("CURSOR_HOME", str(home / ".cursor"))) / "mcp.json",
    }


def read_config(path):
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    return tomllib.loads(text) if path.suffix == ".toml" else json.loads(text)


def registration(path, harness):
    config = read_config(path)
    section = "mcpServers" if harness in {"claude", "cursor"} else "mcp_servers"
    return config.get(section, {}).get(SERVER_ID)


def backup(home, paths):
    directory = home / "Archives"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = directory / f"dotagents-1password-{time.time_ns()}.tar.gz"
    with target.open("xb") as output:
        os.chmod(target, 0o600)
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, path in paths.items():
                if path.exists():
                    archive.add(path, arcname=f"{name}/{path.name}")
    return str(target)


def register(home, command):
    paths = config_paths(home)
    binaries = {name: executable(name) for name in ("claude", "codex", "grok", "cursor-agent")}
    changed = []
    create = []
    migrate = []
    for name, path in paths.items():
        if path.is_symlink():
            raise SetupError(f"config_owned_elsewhere: {name}の設定がsymlinkです")
        config = read_config(path)
        section = "mcpServers" if name in {"claude", "cursor"} else "mcp_servers"
        legacy = config.get(section, {}).get("1password")
        current = registration(path, name)
        matches = lambda item: item and item.get("command") == command and item.get("args", []) == [] and item.get("enabled", True)
        if current and not matches(current):
            raise SetupError(f"registration_conflict: {name}に別のonepassword設定があります")
        if legacy and not matches(legacy):
            raise SetupError(f"registration_conflict: {name}の旧1password設定を確認してください")
        if not current:
            create.append(name)
        if legacy:
            migrate.append(name)
        if not current or legacy:
            changed.append(name)
    archive = backup(home, {name: paths[name] for name in changed}) if changed else None
    for name in changed:
        if name == "cursor":
            path = paths[name]
            data = read_config(path)
            servers = data.setdefault("mcpServers", {})
            servers[SERVER_ID] = {"command": command, "args": []}
            if name in migrate:
                del servers["1password"]
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
                temporary = Path(file.name)
                json.dump(data, file, ensure_ascii=False, indent=2)
                file.write("\n")
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
            continue
        scope = ["--scope", "user"] if name in {"claude", "grok"} else []
        if name in create:
            run([binaries[name], "mcp", "add", *scope, SERVER_ID, "--", command])
        if name in migrate:
            run([binaries[name], "mcp", "remove", *scope, "1password"])
    # Cursorの登録と承認は別の状態。設定が一致する再実行でも公式入口で有効化する。
    run([binaries["cursor-agent"], "mcp", "enable", SERVER_ID])
    for name, path in paths.items():
        value = registration(path, name)
        if not value or value.get("command") != command or value.get("args", []) != []:
            raise SetupError(f"registration_readback_failed: {name}")
    return {"harnesses": list(paths), "changed": changed, "backup": archive}


class MCP:
    def __init__(self, command):
        self.process = subprocess.Popen([command], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
        self.messages = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        for line in self.process.stdout:
            self.messages.put(line)
        self.messages.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def call(self, method, params, timeout=30):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            try:
                line = self.messages.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty as error:
                raise SetupError(f"mcp_timeout: {method}") from error
            if line is None:
                raise SetupError(f"mcp_closed: {method}")
            message = json.loads(line)
            if message.get("id") != self.next_id:
                continue
            if "error" in message:
                raise SetupError(f"mcp_error: {message['error'].get('message')}")
            return message["result"]

    def close(self):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()


def mcp_probe(command, authenticate=False):
    client = MCP(command)
    try:
        client.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                   "clientInfo": {"name": "dotagents-1password", "version": "1"}})
        client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        names = {tool["name"] for tool in client.call("tools/list", {}).get("tools", [])}
        if not {"authenticate", "list_environments"}.issubset(names):
            raise SetupError("mcp_tools_invalid: 認証と環境一覧の公式toolがありません")
        result = {"protocol_verified": True, "tool_count": len(names), "authenticated": False}
        if authenticate:
            response = client.call("tools/call", {"name": "authenticate", "arguments": {}}, timeout=120)
            if response.get("isError"):
                raise SetupError("mcp_authentication_failed: 1Passwordで認証してください")
            account = json.loads(next(item["text"] for item in response["content"] if item["type"] == "text"))["account_id"]
            response = client.call("tools/call", {"name": "list_environments", "arguments": {"accountId": account}}, timeout=120)
            if response.get("isError"):
                raise SetupError("mcp_list_failed: 環境一覧を取得できません")
            environments = json.loads(next(item["text"] for item in response["content"] if item["type"] == "text"))["environments"]
            result.update(authenticated=True, environment_count=len(environments))
        return result
    finally:
        client.close()


def cli_probe(profile, configure_only):
    command = executable("op")
    try:
        run([command, "whoami", "--format", "json"], timeout=30)
        return {"cli_authenticated": True}
    except (SetupError, subprocess.TimeoutExpired) as error:
        previous = str(error)
    if profile == "server" or configure_only:
        return {"cli_authenticated": False, "authentication_error": previous}
    try:
        accounts = json.loads(run([command, "account", "list", "--format", "json"]))
        if len(accounts) != 1:
            raise SetupError("account_selection_required: 1Passwordアプリへサインインし、使用するアカウントを選んでください")
        token = run([command, "signin", "--account", accounts[0]["account_uuid"], "--raw"], timeout=120, sensitive=True)
        if token.strip():
            # desktop連携ではsession tokenを扱わない。手動認証を暗黙に採用しない。
            raise SetupError("desktop_integration_required: 1PasswordアプリのCLI連携を有効にしてください")
        run([command, "whoami", "--format", "json"], timeout=30)
        return {"cli_authenticated": True}
    except (SetupError, subprocess.TimeoutExpired) as error:
        return {"cli_authenticated": False, "authentication_error": str(error)}


SERVER_PROFILE = '''# dotagents所有: 1Passwordの限定Service Accountを初期環境へ渡す。
case $- in *x*) _dotagents_op_trace=1; set +x ;; *) _dotagents_op_trace=0 ;; esac
if OP_SERVICE_ACCOUNT_TOKEN=$(systemd-creds --user --refuse-null --name=op-service-account-token decrypt "$HOME/.config/dotagents/credentials/1password/main-server.cred" -); then
    export OP_SERVICE_ACCOUNT_TOKEN
else
    unset OP_SERVICE_ACCOUNT_TOKEN
    printf '%s\\n' '1Password Service Accountの復号に失敗しました' >&2
    if [ "$_dotagents_op_trace" = 1 ]; then unset _dotagents_op_trace; set -x; else unset _dotagents_op_trace; fi
    return 1
fi
if [ "$_dotagents_op_trace" = 1 ]; then unset _dotagents_op_trace; set -x; else unset _dotagents_op_trace; fi
'''


def provision_server(host):
    # 認証情報の正本は1Password。SSHのstdinには値を渡すが、argv・平文fileには渡さない。
    tag = "dotagents-1password-main-server"
    items = json.loads(run(["op", "item", "list", "--tags", tag, "--format", "json"]))
    if len(items) > 1:
        raise SetupError("service_account_conflict: サーバー用認証情報が複数あります")
    if items:
        token = run(["op", "item", "get", items[0]["id"], "--fields", "credential", "--reveal"], sensitive=True).strip()
    else:
        vaults = json.loads(run(["op", "vault", "list", "--format", "json"]))
        matches = [vault for vault in vaults if vault["name"] == "開発工場"]
        if len(matches) > 1:
            raise SetupError("vault_conflict: 開発工場の保管庫が複数あります")
        vault = matches[0] if matches else json.loads(run(["op", "vault", "create", "開発工場", "--format", "json"]))
        token = run(["op", "service-account", "create", "dotagents-main-server", "--raw",
                     "--vault", vault["id"] + ":read_items,write_items"], sensitive=True).strip()
        item = json.loads(run(["op", "item", "template", "get", "API Credential"]))
        item.update(title="dotagents / main-server / 1Password", tags=[tag])
        next(field for field in item["fields"] if field["id"] == "credential")["value"] = token
        run(["op", "item", "create", "-", "--format", "json"], input=json.dumps(item), sensitive=True)
    profile_encoded = base64.b64encode(SERVER_PROFILE.encode()).decode()
    remote = f'''
import os,sys,subprocess,base64,json,tarfile,time,tempfile
from pathlib import Path
home=Path.home()
credential=home/".config/dotagents/credentials/1password/main-server.cred"
profile=home/".bashrc.d/1password.sh"
content=base64.b64decode({profile_encoded!r}).decode()
token=sys.stdin.read().strip()
if credential.is_symlink() or profile.is_symlink():
    raise RuntimeError("credential_owned_elsewhere: symlinkは変更できません")
if credential.exists() and profile.exists() and profile.read_text()==content:
    previous=subprocess.run(["systemd-creds","--user","--refuse-null","--name=op-service-account-token","decrypt",str(credential),"-"],capture_output=True,text=True)
    if previous.returncode:raise RuntimeError(previous.stderr)
    if previous.stdout.strip()==token:
        probe=subprocess.run(["bash","-lc","op whoami --format json >/dev/null"],capture_output=True,text=True)
        if probe.returncode:raise RuntimeError(probe.stderr)
        print(json.dumps({{"server_authenticated":True,"encrypted_credential":True,"profile_installed":True,"changed":False}}))
        raise SystemExit(0)
if profile.exists() and profile.read_text()!=content:
    raise RuntimeError("profile_conflict: 既存の1Password profileを確認してください")
archive=home/"Archives"/f"dotagents-1password-server-{{time.time_ns()}}.tar.gz"
archive.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
with archive.open("xb") as stream:
    os.chmod(archive,0o600)
    with tarfile.open(fileobj=stream,mode="w:gz") as tar:
        for path in (credential,profile):
            if path.exists():tar.add(path,arcname=str(path.relative_to(home)))
credential.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
with tempfile.TemporaryDirectory(dir=credential.parent) as directory:
    temporary=Path(directory)/"credential"
    result=subprocess.run(["systemd-creds","--user","--with-key=host","--name=op-service-account-token","encrypt","-",str(temporary)],input=token,text=True,capture_output=True)
    if result.returncode:raise RuntimeError(result.stderr)
    os.chmod(temporary,0o600)
    os.replace(temporary,credential)
profile.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
profile.write_text(content)
os.chmod(profile,0o600)
probe=subprocess.run(["bash","-lc","op whoami --format json >/dev/null"],capture_output=True,text=True)
if probe.returncode:raise RuntimeError(probe.stderr)
print(json.dumps({{"server_authenticated":True,"encrypted_credential":True,"profile_installed":True}}))
'''
    output = run(["ssh", "-o", "BatchMode=yes", "--", host, "python3 -c " + shlex.quote(remote)], input=token, timeout=120, sensitive=True)
    return json.loads(output)


def main():
    parser = argparse.ArgumentParser(description="公式1Passwordを導入し、4ハーネスへ登録して疎通する")
    parser.add_argument("--profile", choices=("mac", "linux", "server", "windows-native"), required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--authenticate", action="store_true", help="公式MCPの本人認証と環境一覧を確認する（既定）")
    mode.add_argument("--configure-only", action="store_true", help="本人不在時に導入・登録だけ行い、認証待ちを返す")
    parser.add_argument("--server-host", help="指定したLinuxサーバーへ限定Service Accountの暗号化資格情報を接続する")
    args = parser.parse_args()
    expected = {"mac": "darwin", "linux": "linux", "server": "linux", "windows-native": "win32"}
    if expected[args.profile] != sys.platform:
        raise SetupError("profile_platform_mismatch: profileと実OSが一致しません")
    install(args.profile)
    result = {"schema": "dotagents.1password-setup.v1", "profile": args.profile,
              "cli_version": run([executable("op"), "--version"]).strip()}
    result["cli_harnesses"] = [name for name in ("claude", "codex", "grok", "cursor-agent") if executable(name)]
    command = mcp_command(args.profile)
    if command:
        # 非対応・壊れた実行ファイルを親へ登録しない。
        result["mcp"] = mcp_probe(command)
        result["registration"] = register(Path.home(), command)
    else:
        result["mcp"] = {"status": "desktop_required", "reason": "画面のないhostでは公式MCPのdesktop認証を使用できません"}
    result.update(cli_probe(args.profile, args.configure_only))
    if command and not args.configure_only:
        if result["cli_authenticated"]:
            try:
                result["mcp"] = mcp_probe(command, authenticate=True)
            except SetupError as error:
                result["mcp"]["authentication_error"] = str(error)
        else:
            result["mcp"]["authentication_error"] = "CLIの本人認証後にMCPの認証を確認してください"
    result["ready"] = result["cli_authenticated"] and (command is None or result["mcp"]["authenticated"])
    if args.server_host:
        if not result["ready"]:
            raise SetupError("authentication_required: サーバー用認証を作成する本人認証が必要です")
        result["server"] = provision_server(args.server_host)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ready"] else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (SetupError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2) from error
