import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { CURRENT_WIRE_PRODUCT_IDS } from '../../lib/factory/deployment-contract.mjs';
import { assertWindowsNativeProductSmoke } from '../../lib/factory/windows-native-product-smoke.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SETUP = join(ROOT, 'bin', 'setup-windows-native-factory.ps1');

test('Windows native一撃setupは工場展開・配線・fresh BugHub受理・検証・2時schedulerを一入口に閉じる', async () => {
  const source = await readFile(SETUP, 'utf8');
  const prerequisites = source.slice(source.indexOf('function Ensure-WindowsPrerequisites'), source.indexOf('function Convert-ToGitBashPath'));
  assert.match(prerequisites, /Test-External -File 'codex'.*npm\.cmd'.*'install', '-g', '@openai\/codex@latest'.*Refresh-ProcessPath.*-File 'codex'.*'--version'/su);
  const main = source.slice(source.indexOf('try {\n  Normalize-WindowsReporterConfig'));
  const ordered = ['if (-not $ScheduledRun)', 'Remove-LegacyCron', 'dotagents-links: install.sh',
    'codex-config: apply-codex-config.sh', 'cursor-config: apply-cursor-config.sh',
    'Ensure-MainServerSsh', 'daily-0200-task', 'Invoke-FactoryUpdate $update $productSmoke',
    'Invoke-VerifyInstall $verify', 'Write-Receipt'];
  let cursor = -1;
  for (const token of ordered) {
    const next = main.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${token} が正規順序にない`);
    cursor = next;
  }
  assert.doesNotMatch(source, /Ensure-ClaudeMcp|Ensure-CodexMcp|Invoke-LatticeHookInstall|legacyUndefined|Set-ToolchainPostGateSuccess|--post-update|--finalize-update/u);
  assert.match(source, /if \(-not \$ScheduledRun\) \{ \$updateArguments \+= '--setup' \}/u);
  assert.match(source, /\$GitBash @updateArguments.*updateCode -ne 0/su);
  assert.match(source, /factory-reporter-scheduler\.mjs.*uninstall.*--apply/su);
  assert.doesNotMatch(source, /Start-Process.*-Verb RunAs/su);
  assert.doesNotMatch(source, /WindowsBuiltInRole\]::Administrator/u);
  assert.match(source, /Stop-ScheduledTask.*factory-reporter-scheduler\.mjs.*uninstall.*Remove-LegacyCron.*install\.sh/su);
  assert.match(source, /function Normalize-WindowsReporterConfig.*UTF-8 without BOM.*factory-reporter-config.*\.bak.*UTF8Encoding.*\$false.*still has a UTF-8 BOM/su);
  assert.match(source, /function Restore-ScheduledReporterConfigFromCodexCache.*ScheduledRun.*OpenAI\.Codex_\*.*LocalCache\\Local\\dotagents\\factory-reporter\\config\.json.*credential path is not canonical.*Set-OwnerOnlyAcl \$destinationCredential.*Restore-ScheduledReporterConfigFromCodexCache.*Assert-ReporterConfig/su);
  assert.match(source, /function Restore-ScheduledGitHubCliConfigFromCodexCache.*gh.*auth.*status.*OpenAI\.Codex_\*.*LocalCache\\Roaming\\GitHub CLI\\hosts\.yml.*Set-OwnerOnlyAcl \$destination.*authentication was not restored.*Restore-ScheduledGitHubCliConfigFromCodexCache.*github-auth-switch/su);
  assert.match(source, /-File 'python' -Arguments @\(\$applyCodex, '--apply'\)/u);
  assert.match(source, /-File 'python' -Arguments @\(\$applyClaude, '--apply'\)/u);
  assert.match(source, /\.grok\\auth\.json/u);
  assert.match(source, /XAI_API_KEY/u);
  assert.match(source, /Grok not logged in\. Skipping apply-grok-config/u);
  assert.match(source, /python.*apply-grok-config\.sh/su);
  assert.doesNotMatch(source, /lattice hooks install --host grok/u);
  assert.match(source, /function Invoke-VerifyInstall.*if \(\$code -ne 0\) \{ throw "verify-install failed with exit \$code" \}.*return 'passed'/su);
  assert.doesNotMatch(source, /LatticeUnsupported|known Lattice native-Windows status\/install contract mismatch|failureMarkers|latticeFailures|latticeHosts/su);
  assert.match(source, /function Normalize-WindowsCodexHooks.*codex-callout-hook.*orchestrate-advisory-hook.*codex-lattice-gantt-hook/su);
  assert.match(source, /\$null \| & \$File @Arguments/u);
  assert.match(source, /function Test-External.*Get-Command.*ErrorActionPreference = 'Continue'.*return \$code -eq 0/su);
  assert.match(source, /function Invoke-Checked.*& \$File @Arguments \| ForEach-Object \{ Write-Host \$_ \}.*\$LASTEXITCODE/su);
  assert.match(source, /FACTORY_REPORTER_RUNNER.*factory-reporter-v8-schedule-runner/su);
  assert.match(source, /function Remove-LegacyCron.*crontab -l.*agents-update.*factory-reporter.*crontab -/su);
  assert.doesNotMatch(source, /Caveat-Private|\.caveat\\own\\\.git|caveat-sync(?:-init)?|@\('codex-hook', 'install'\)/u);
  assert.match(source, /delivery_acknowledged/u);
  assert.match(source, /lib\\factory\\windows-native-product-smoke\.mjs/u);
  assert.match(source, /checked_products -ne 15/u);
  assert.match(source, /run-\$RunId\.log.*Start-Transcript.*Set-OwnerOnlyAcl \$TranscriptPath.*Stop-Transcript/su);
  assert.match(source, /function Set-OwnerOnlyAcl.*existingOwnerSid.*DirectorySecurity.*FileSecurity.*existingOwnerSid -ne \$sid\.Value.*SetOwner\(\$sid\).*SetAccessRuleProtection/su);
  assert.match(source, /PSEdition -ne 'Core'.*PSVersion\.Major -lt 7.*official GitHub release win-x64 MSI.*machine scope/su);
  assert.match(source, /Microsoft\.PowerShell.*winget installation failed.*officialPowerShell @relayArguments/su);
  assert.match(source, /function Ensure-WindowsPrerequisites.*Git\.Git.*OpenJS\.NodeJS\.LTS.*GitHub\.cli.*Python\.Python\.3\.13.*astral-sh\.uv.*ezwinports\.make.*koalaman\.shellcheck.*BurntSushi\.ripgrep\.MSVC/su);
  assert.match(source, /function Ensure-WindowsPrerequisites.*ssh.*ssh-keygen.*ssh-keyscan.*Git\.Git/su);
  assert.match(source, /function Ensure-MainServerSsh.*id_ed25519_main_server.*ssh-keygen.*Set-OwnerOnlyAcl.*Ensure-MainServerKnownHost.*Ensure-MainServerSshConfig.*Invoke-MainServerKeyEnrollment.*three reconnects passed/su);
  assert.match(source, /MainServerHostKeyFingerprint = 'SHA256:TLhN\/5MaQ7MR2Y0E6c9G1ZQK23UfidDZlsdCjLVCOWs'.*function Ensure-MainServerKnownHost.*ssh-keyscan.*pinned fingerprint/su);
  assert.match(source, /function Ensure-MainServerSshConfig.*Host \$MainServerAlias \$MainServerHost.*HostName.*IdentityFile.*IdentitiesOnly yes.*StrictHostKeyChecking yes.*ssh -G.*direct-IP/su);
  assert.match(source, /function Invoke-MainServerKeyEnrollment.*enroll-windows-main-server-ssh\.yml.*priorIds.*MAIN_SERVER_WINDOWS_PUBLIC_KEY.*gh run view.*did not complete within 20 minutes/su);
  assert.match(source, /ssh -o BatchMode=yes.*"\$MainServerUser@\$MainServerHost".*dotagents-main-server-direct-ssh-ok/su);
  assert.match(source, /node --version.*\[int\]\$Matches\[1\] -lt 24.*Node\.js 24以上/su);
  assert.doesNotMatch(source, /WindowsPowerShell\\v1\.0\\powershell\.exe/u);
  assert.match(source, /FileSystemAclExtensions\]::SetAccessControl\(\$item, \$acl\)/u);
  assert.doesNotMatch(source, /\bSet-Acl\b/u);
  assert.match(source, /Get-Acl -LiteralPath \$Path.*GetOwner.*GetAccessRules.*IsInherited.*Owner-only ACL readback failed/su);
  assert.match(source, /THROUGHLINE_CODEX_THREAD_ID.*CODEX_THREAD_ID/su);
  assert.match(source, /function Get-CodexReceiptMirrorPaths.*OpenAI\.Codex_\*.*scheduled-receipt\.json.*function Write-Receipt.*ScheduledRun.*Get-CodexReceiptMirrorPaths.*Set-OwnerOnlyAcl \$mirror.*function Wait-ScheduledSmoke.*priorLastRunTime.*Start-ScheduledTask.*LastRunTime -le \$priorLastRunTime.*LastTaskResult -ne 0.*Get-CodexReceiptMirrorPaths.*fresh acknowledged receipt/su);
  assert.match(source, /-ScheduledRun/u);
  assert.doesNotMatch(source, /\bwsl(?:\.exe)?\b/iu);
});

test('Windows native一撃setupのPlanOnlyはPowerShell 7で端末を書き換えず全工程を公開する', { skip: process.platform !== 'win32' }, async () => {
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SETUP, '-PlanOnly'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  assert.equal(value.schema, 'dotagents.windows-native-factory-setup-plan.v1');
  assert.equal(value.platform, 'windows-native');
  assert.deepEqual(value.steps, [
    'prerequisite-packages', 'factory-reporter-config', 'retire-legacy-schedulers',
    'dotagents-links', 'factory-config', 'main-server-ssh', 'daily-0200-task',
    'product-update-and-setup', 'fresh-bughub-delivery', 'all-product-smoke', 'verify-install',
  ]);
});

test('Windows native一撃setupはWindows PowerShell 5.1を明示拒否する', { skip: process.platform !== 'win32' }, () => {
  const windowsPowerShell = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SETUP, '-PlanOnly'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PowerShell 7.*official GitHub release.*MSI.*machine scope/u);
});

function passingProduct(checkIds) {
  return { presence_status: 'installed', installed_version: '1.0.0', compatibility_status: 'compatible', checks: checkIds.map((check_id) => ({ check_id, status: 'pass' })) };
}

test('Windows native全製品smokeはwire v8の15 ID・製品別実動作・構造的非対応を全件検証する', () => {
  const report = {
    schema_version: '8.0', host_profile: 'windows-native', platform: { os: 'windows', arch: process.arch },
    products: Object.fromEntries(CURRENT_WIRE_PRODUCT_IDS.map((id) => [id, passingProduct(['native_diagnostics'])])),
  };
  report.products.caveat = passingProduct(['native_diagnostics']);
  report.products.throughline = passingProduct(['database_schema', 'codex_hooks', 'restore']);
  report.products.spotter = passingProduct(['project_activation', 'marker_schema', 'throughline_context', 'claude_catalog', 'codex_catalog', 'audit_catalog_readiness']);
  report.products.lattice = passingProduct(['native_diagnostics']);
  report.products.markitdown = passingProduct(['local_fixture']);
  report.products['gpt-connector'] = passingProduct(['version', 'state_schema', 'job_schema', 'mcp_contract']);
  report.products['aiterm-mcp'] = passingProduct(['mcp', 'runtime_error_store']);
  report.products['codex-sidecar'] = passingProduct(['native_diagnostics']);
  report.products.peertable = passingProduct(['version_consistency', 'bin_integrity', 'node_runtime', 'skill_bundle']);
  report.products.unai = passingProduct(['manifest_consistency', 'node_runtime', 'skill_bundle']);
  report.products['claude-code'] = passingProduct(['installed_version', 'required_hooks', 'last_update']);
  report.products['codex-cli'] = passingProduct(['installed_version', 'config_parser', 'native_routing', 'required_hooks', 'last_update']);
  report.products['grok-build'] = passingProduct(['stable_update', 'last_update']);
  report.products.aishell = { presence_status: 'not_applicable', compatibility_status: 'unsupported', checks: [{ check_id: 'native_diagnostics', status: 'unsupported', reason_code: 'platform_unsupported' }] };
  report.products.servermanager = { presence_status: 'not_applicable', checks: [] };

  const receipt = assertWindowsNativeProductSmoke(report, process.arch);
  assert.equal(receipt.checked_products, 15);
  const leftover = structuredClone(report);
  leftover.products.observer = { presence_status: 'not_applicable', compatibility_status: 'unsupported', checks: [] };
  assert.throws(() => assertWindowsNativeProductSmoke(leftover, process.arch), /observer/u);
  assert.equal(receipt.status, 'passed');
  const broken = structuredClone(report); broken.products.markitdown.checks[0].status = 'fail';
  assert.throws(() => assertWindowsNativeProductSmoke(broken, process.arch), /markitdown/u);
  const freshThroughline = structuredClone(report);
  for (const checkId of ['database_schema', 'restore']) {
    const item = freshThroughline.products.throughline.checks.find((check) => check.check_id === checkId);
    Object.assign(item, { status: 'skipped', reason_code: 'not_applicable' });
  }
  assert.equal(assertWindowsNativeProductSmoke(freshThroughline, process.arch).status, 'passed');
  freshThroughline.products.throughline.checks.find((check) => check.check_id === 'restore').reason_code = 'diagnostic_unverified';
  assert.throws(() => assertWindowsNativeProductSmoke(freshThroughline, process.arch), /throughline:restore/u);
  const incomplete = structuredClone(report); delete incomplete.products.peertable;
  assert.throws(() => assertWindowsNativeProductSmoke(incomplete, process.arch), /product set/u);
});
