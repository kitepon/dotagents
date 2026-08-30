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
  const ordered = [
    'install.sh',
    'agents-update.sh',
    'apply-codex-config.sh',
    'apply-grok-config.sh',
    "@('init')",
    'throughline',
    "@('codex-hook', 'install')",
    'markitdown',
    'lattice hooks install --host claude',
    'lattice hooks install --host codex',
    'spotter install -y',
    'verify-install.sh',
    'factory-reporter-v8-schedule-runner.mjs',
    'agents-update-scheduler.mjs',
  ];
  let cursor = -1;
  for (const token of ordered) {
    const next = source.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${token} が正規順序にない`);
    cursor = next;
  }
  assert.match(source, /factory-reporter-scheduler\.mjs.*uninstall.*--apply/su);
  assert.doesNotMatch(source, /Start-Process.*-Verb RunAs/su);
  assert.doesNotMatch(source, /WindowsBuiltInRole\]::Administrator/u);
  assert.match(source, /Stop-ScheduledTask.*factory-reporter-scheduler\.mjs.*uninstall.*Remove-LegacyCron.*install\.sh/su);
  assert.match(source, /function Normalize-WindowsReporterConfig.*UTF-8 without BOM.*factory-reporter-config.*\.bak.*UTF8Encoding.*\$false.*still has a UTF-8 BOM/su);
  assert.match(source, /python3.*apply-codex-config\.sh/su);
  assert.match(source, /\.grok\\auth\.json/u);
  assert.match(source, /XAI_API_KEY/u);
  assert.match(source, /Grok not logged in\. Skipping apply-grok-config/u);
  assert.match(source, /python.*apply-grok-config\.sh/su);
  assert.doesNotMatch(source, /lattice hooks install --host grok/u);
  assert.match(source, /HOST_PLATFORM_UNSUPPORTED.*structurally unsupported/su);
  assert.match(source, /function Invoke-VerifyInstall.*if \(\$code -ne 0\) \{ throw "verify-install failed with exit \$code" \}.*return 'passed'/su);
  assert.doesNotMatch(source, /LatticeUnsupported|known Lattice native-Windows status\/install contract mismatch|failureMarkers|latticeFailures|latticeHosts/su);
  assert.match(source, /function Normalize-WindowsCodexHooks.*codex-callout-hook.*orchestrate-advisory-hook.*codex-lattice-gantt-hook/su);
  assert.match(source, /CODEX_HOME.*native-product-wiring: caveat/su);
  assert.match(source, /\$null \| & \$File @Arguments/u);
  assert.match(source, /caveat' -Arguments @\('init'\) -ClosedStdin/u);
  assert.match(source, /legacy undefined HOME/su);
  assert.match(source, /function Test-External.*Get-Command.*ErrorActionPreference = 'Continue'.*return \$code -eq 0/su);
  assert.match(source, /function Invoke-Checked.*& \$File @Arguments \| ForEach-Object \{ Write-Host \$_ \}.*\$LASTEXITCODE/su);
  assert.match(source, /FACTORY_REPORTER_RUNNER.*factory-reporter-v8-schedule-runner/su);
  assert.match(source, /function Remove-WindowsGlobalNpmLink.*npm root --global.*LinkType.*npm unlink --global.*Global npm link remains.*Remove-WindowsGlobalNpmLink 'aiterm-mcp'.*Invoke-BootstrapUpdate/su);
  assert.match(source, /function Update-WindowsNativeClaude.*\.local\\bin\\claude\.exe.*factory-products-bootstrap: Claude native update.*install\.sh.*Update-WindowsNativeClaude.*Invoke-BootstrapUpdate/su);
  assert.match(source, /function Remove-LegacyCron.*crontab -l.*agents-update.*factory-reporter.*crontab -/su);
  assert.match(source, /gh' -Arguments @\('auth', 'switch', '--hostname', 'github\.com', '--user', 'kitepon-rgb'\).*gh' -Arguments @\('auth', 'setup-git'\).*https:\/\/github\.com\/kitepon-rgb\/Caveat-Private\.git/su);
  assert.match(source, /delivery_acknowledged/u);
  assert.match(source, /--post-update.*--finalize-update/su);
  assert.match(source, /Set-ToolchainPostGateSuccess.*--post-gate', 'success'/su);
  assert.match(source, /@\(Compare-Object -ReferenceObject \(\$expected \| Sort-Object\) -DifferenceObject \$actual\)\.Count -ne 0/u);
  assert.match(source, /lib\\factory\\windows-native-product-smoke\.mjs/u);
  assert.match(source, /checked_products -ne 15/u);
  assert.match(source, /run-\$RunId\.log.*Start-Transcript.*Set-OwnerOnlyAcl \$TranscriptPath.*Stop-Transcript/su);
  assert.match(source, /function Set-OwnerOnlyAcl.*DirectorySecurity.*FileSecurity.*SetOwner\(\$sid\).*SetAccessRuleProtection/su);
  assert.match(source, /PSEdition -ne 'Core'.*PSVersion\.Major -lt 7.*official GitHub release win-x64 MSI.*machine scope/su);
  assert.match(source, /node --version.*\[int\]\$Matches\[1\] -lt 24.*Node\.js 24以上/su);
  assert.doesNotMatch(source, /WindowsPowerShell\\v1\.0\\powershell\.exe/u);
  assert.match(source, /FileSystemAclExtensions\]::SetAccessControl\(\$item, \$acl\)/u);
  assert.doesNotMatch(source, /\bSet-Acl\b/u);
  assert.match(source, /Get-Acl -LiteralPath \$Path.*GetOwner.*GetAccessRules.*IsInherited.*Owner-only ACL readback failed/su);
  assert.match(source, /THROUGHLINE_CODEX_THREAD_ID.*CODEX_THREAD_ID/su);
  assert.match(source, /function Wait-ScheduledSmoke.*priorLastRunTime.*Start-ScheduledTask.*LastRunTime -le \$priorLastRunTime.*LastTaskResult -ne 0.*completed without a receipt.*fresh acknowledged receipt/su);
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
    'factory-reporter-config',
    'retire-legacy-schedulers',
    'dotagents-links',
    'factory-products-bootstrap',
    'codex-config',
    'native-product-wiring',
    'lattice-hooks',
    'spotter-project',
    'mcp-registration',
    'caveat-sync',
    'verify-install',
    'fresh-bughub-delivery',
    'toolchain-finalization',
    'all-product-smoke',
    'daily-0200-task',
  ]);
});

test('Windows native一撃setupはWindows PowerShell 5.1を明示拒否する', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SETUP, '-PlanOnly'], { encoding: 'utf8' });
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
  const incomplete = structuredClone(report); delete incomplete.products.peertable;
  assert.throws(() => assertWindowsNativeProductSmoke(incomplete, process.arch), /product set/u);
});
