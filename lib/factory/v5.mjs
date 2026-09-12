import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './command.mjs';
import { parseCaveatDiagnostic } from './caveat-diagnostics.mjs';
import { collectLatticeRuntimeErrors, collectServerManagerExternalEvents } from './runtime-errors.mjs';
import { aishellProduct, latticeProduct, mergeServerManagerExternal, serverManagerNative } from './scan.mjs';
import { compareSemver, parseNpmLatestJson, validateGrokUpdateCheck } from './toolchain-contract.mjs';

export const V5_PRODUCT_IDS = Object.freeze(['caveat', 'throughline', 'spotter', 'lattice', 'markitdown', 'gpt-connector', 'aiterm-mcp', 'codex-sidecar', 'servermanager', 'claude-code', 'codex-cli', 'grok-build', 'aishell']);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FORBIDDEN = /(?:Bearer\s+\S+|(?:^|[\s"'])\/(?:home|Users)\/|[A-Za-z]:\\Users\\|-----BEGIN|\b(?:sk|ghp)_[A-Za-z0-9_-]+)/i;
const NPM_CLI = { 'claude-code': { command: 'claude', package: '@anthropic-ai/claude-code' }, 'codex-cli': { command: 'codex', package: '@openai/codex' } };

function empty() { return { presence_status: 'unverified', contract_version: '5.0', checks: [], runtime_errors: [], resolutions: [] }; }
function check(check_id, status, reason_code) { return { check_id, status, ...(reason_code ? { reason_code } : {}) }; }
function semver(value) { return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value); }
function version(stdout) { return stdout.trim().match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/u)?.[0] ?? null; }
function exact(value, keys, error = 'native_diagnostics_schema') { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(error); }
function nativeStatusV1(value) { return ['ready', 'not_ready', 'not_applicable', 'unverified'].includes(value); }
function nativeReason(value) { return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value); }
function canonicalReason(status) { return status === 'ready' ? 'ready' : status === 'not_ready' ? 'not_ready' : status === 'not_applicable' ? 'not_applicable' : 'diagnostic_unverified'; }
export function throughlineDiagnostic(diagnostic) {
  const components = [
    ['database_schema', diagnostic?.databaseSchema], ['codex_hooks', diagnostic?.hooks],
    ['capture', diagnostic?.readiness?.capture], ['restore', diagnostic?.readiness?.restore],
    ['handoff', diagnostic?.readiness?.handoff], ['evidence_restore_smoke', diagnostic?.evidence?.restoreSmoke],
    ['claude_connector', diagnostic?.connectors?.claude],
  ].map(([id, value]) => {
    if (!nativeStatusV1(value?.status) || !nativeReason(value?.reason)) throw new Error('native_diagnostics_schema');
    return { id, status: value.status, reason: value.reason };
  });
  if (!semver(diagnostic.version) || !nativeStatusV1(diagnostic.overall?.status)
    || typeof diagnostic.databaseSchema.schema !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(diagnostic.databaseSchema.schema)) throw new Error('native_diagnostics_schema');
  return { overall: diagnostic.overall.status, state: diagnostic.databaseSchema.schema,
    migration: diagnostic.databaseSchema.status === 'ready' ? 'current' : diagnostic.databaseSchema.status === 'not_ready' ? 'failed' : 'unverified',
    version: diagnostic.version, components };
}
export function spotterDiagnostic(diagnostic, result) {
  const verdicts = { compatible: 'ready', incompatible: 'not_ready', not_applicable: 'not_applicable', indeterminate: 'unverified' };
  // 記録する公開結果だけを読む。schema世代・catalog・hook・詳細checkは製品が所有する。
  if (!semver(diagnostic?.version) || typeof diagnostic.compatibility_status !== 'string'
    || !Object.hasOwn(verdicts, diagnostic.compatibility_status)) throw new Error('native_diagnostics_schema');
  const exitCode = ['compatible', 'not_applicable'].includes(diagnostic.compatibility_status) ? 0 : 1;
  if (result?.code !== exitCode || result.ok !== (exitCode === 0)) throw new Error('native_exit_mismatch');
  return { overall: verdicts[diagnostic.compatibility_status], version: diagnostic.version, components: null };
}
export function aitermDiagnostic(diagnostic) {
  if (!semver(diagnostic?.version) || !nativeStatusV1(diagnostic.overall)) throw new Error('native_diagnostics_schema');
  const components = [
    ['mcp', diagnostic.mcp?.tool_call], ['pty_list', diagnostic.pty_list?.status],
    ['runtime_error_store', diagnostic.runtime_error_store?.status],
  ].map(([id, status]) => {
    if (!nativeStatusV1(status)) throw new Error('native_diagnostics_schema');
    return { id, status, reason: canonicalReason(status) };
  });
  return { overall: diagnostic.overall, version: diagnostic.version, components };
}
export function sidecarDiagnostic(diagnostic) {
  const readiness = diagnostic?.factoryReadiness;
  const installedVersion = readiness?.packageVersions?.packages?.cli ?? null;
  if (!nativeStatusV1(readiness?.overall) || (installedVersion !== null && !semver(installedVersion))) throw new Error('native_diagnostics_schema');
  return { overall: readiness.overall, version: installedVersion };
}
function failure(product, checkId, reason, now) { return { check_id: checkId, status: 'fail', severity: 'high', fingerprint: createHash('sha256').update(`${product}\0${checkId}\0${reason}`).digest('hex'), message_template: `${product} ${checkId} failed`, occurrence_count: 1, first_seen: now, last_seen: now, reason_code: reason }; }
function componentChecks(product, components, now) { return components.map((item) => item.status === 'ready' ? check(item.id, 'pass') : item.status === 'not_ready' ? failure(product, item.id, item.reason, now) : check(item.id, item.status === 'not_applicable' ? 'skipped' : 'unverified', item.reason)); }
function unavailable(commandResult, checkId = 'native_diagnostics') { const product = empty(); if (commandResult.reason === 'spawn' && commandResult.error?.code === 'ENOENT') product.presence_status = 'missing'; product.checks.push(check(checkId, 'unverified', product.presence_status === 'missing' ? 'cli_unavailable' : 'native_schema_invalid')); return product; }
function nativeResult(product, id, diagnostic, result, now) {
  try {
    let overall; let state = null; let migration = null; let installedVersion = diagnostic.version; let components = null;
    if (id === 'caveat') ({ overall, state, migration, version: installedVersion } = parseCaveatDiagnostic(diagnostic));
    else if (id === 'throughline') { const parsed = throughlineDiagnostic(diagnostic); ({ overall, state, migration, components } = parsed); installedVersion = parsed.version; }
    else if (id === 'spotter') { const parsed = spotterDiagnostic(diagnostic, result); ({ overall, components } = parsed); installedVersion = parsed.version; }
    else if (id === 'codex-sidecar') { const parsed = sidecarDiagnostic(diagnostic); overall = parsed.overall; installedVersion = parsed.version; if ((overall === 'ready') !== result.ok) throw new Error('native_exit_mismatch'); }
    else { const parsed = aitermDiagnostic(diagnostic); ({ overall, components } = parsed); installedVersion = parsed.version; }
    if (id === 'caveat' && (overall === 'ready') !== result.ok) throw new Error('native_exit_mismatch');
    if (!['caveat', 'codex-sidecar', 'spotter'].includes(id) && !result.ok) throw new Error('native_exit_mismatch');
    const projected = { ...product, ...(installedVersion ? { presence_status: 'installed', installed_version: installedVersion } : {}), ...(state ? { state_schema_version: state } : {}), ...(migration ? { migration_status: migration } : {}) };
    if (components) return { ...projected, compatibility_status: overall === 'ready' ? 'compatible' : overall === 'not_ready' ? 'incompatible' : 'unverified', checks: componentChecks(id, components, now) };
    if (overall === 'ready') return { ...projected, compatibility_status: 'compatible', checks: [check('native_diagnostics', 'pass')] };
    if (overall === 'not_ready') return { ...projected, compatibility_status: 'incompatible', checks: [failure(id, 'native_diagnostics', 'native_not_ready', now)] };
    if (overall === 'not_applicable') return { ...projected, compatibility_status: 'unverified', checks: [check('native_diagnostics', 'skipped', 'native_not_applicable')] };
    return { ...projected, compatibility_status: 'unverified', checks: [check('native_diagnostics', 'unverified', 'native_unverified')] };
  } catch (error) { return { ...product, checks: [check('native_diagnostics', 'unverified', error.message)] }; }
}

export function projectGptConnectorFactory(diagnostic, runtime, exitOk = false, observedAt = new Date().toISOString()) {
  if (!semver(diagnostic?.package_version) || !['ready', 'not_ready', 'unsupported', 'unverified'].includes(diagnostic.overall)
    || typeof diagnostic.state?.schema !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(diagnostic.state.schema)
    || typeof diagnostic.state.migration !== 'string' || !Array.isArray(diagnostic.checks)) throw new Error('gpt_connector_diagnostics_schema');
  for (const item of diagnostic.checks) {
    if (!nativeReason(item?.id) || !['ready', 'not_ready', 'unsupported', 'unverified'].includes(item.status)
      || typeof item.reason !== 'string' || FORBIDDEN.test(item.reason)) throw new Error('gpt_connector_diagnostics_schema');
  }
  if ((diagnostic.overall === 'ready') !== exitOk) throw new Error('gpt_connector_exit_mismatch');
  const result = { installed_version: diagnostic.package_version, state_schema_version: diagnostic.state.schema, migration_status: diagnostic.state.migration === 'current' ? 'current' : diagnostic.state.migration === 'failed' ? 'failed' : 'unverified', compatibility_status: diagnostic.overall === 'ready' ? 'compatible' : diagnostic.overall === 'not_ready' ? 'incompatible' : diagnostic.overall, checks: diagnostic.checks.map((item) => item.status === 'not_ready' ? failure('gpt-connector', item.id, item.reason, observedAt) : check(item.id, item.status === 'ready' ? 'pass' : item.status, item.reason)), runtime_errors: [], resolutions: [] };
  if (runtime !== null) Object.assign(result, projectGptRuntime(runtime)); return result;
}
function projectGptRuntime(value) { exact(value, ['schema', 'product', 'version', 'state_schema_version', 'cursor', 'runtime_errors', 'resolutions', 'diagnostics'], 'gpt_connector_runtime_schema'); if (value.schema !== 'gpt-connector.runtime-errors.v1' || value.product !== 'gpt-connector' || !semver(value.version) || typeof value.state_schema_version !== 'string' || !Array.isArray(value.runtime_errors) || !Array.isArray(value.resolutions) || value.runtime_errors.length > 256 || value.resolutions.length > 256 || FORBIDDEN.test(JSON.stringify(value))) throw new Error('gpt_connector_runtime_privacy'); exact(value.cursor, ['high_watermark', 'acknowledged_through', 'next'], 'gpt_connector_runtime_schema'); exact(value.diagnostics, ['collection', 'status', 'total_count', 'pending_count', 'truncated'], 'gpt_connector_runtime_schema'); const { high_watermark: high, acknowledged_through: acknowledged, next } = value.cursor; if (![high, acknowledged, next].every((item) => Number.isSafeInteger(item) && item >= 0) || acknowledged > high || next > high || !['enabled', 'disabled'].includes(value.diagnostics.collection) || !['ready', 'not_applicable'].includes(value.diagnostics.status) || !Number.isSafeInteger(value.diagnostics.total_count) || !Number.isSafeInteger(value.diagnostics.pending_count) || typeof value.diagnostics.truncated !== 'boolean') throw new Error('gpt_connector_runtime_schema'); const record = (item) => { exact(item, ['error_code', 'component', 'status', 'severity', 'fingerprint', 'message_template', 'occurrence_count', 'first_seen', 'last_seen', 'state_schema_version'], 'gpt_connector_runtime_schema'); if (!/^[A-Z][A-Z0-9_]*(?:\.[A-Z0-9_]+)*$/u.test(item.error_code) || !/^[a-z0-9._-]+$/u.test(item.component) || item.status !== 'open' || !['fatal', 'high', 'warn', 'info'].includes(item.severity) || !/^[a-f0-9]{64}$/u.test(item.fingerprint) || typeof item.message_template !== 'string' || item.message_template.length < 1 || item.message_template.length > 1024 || FORBIDDEN.test(item.message_template) || !Number.isSafeInteger(item.occurrence_count) || item.occurrence_count < 1 || !utc(item.first_seen) || !utc(item.last_seen) || item.first_seen > item.last_seen || typeof item.state_schema_version !== 'string') throw new Error('gpt_connector_runtime_privacy'); return item; }; const resolution = (item) => { exact(item, ['fingerprint', 'resolved_at', 'reason_code'], 'gpt_connector_runtime_schema'); if (!/^[a-f0-9]{64}$/u.test(item.fingerprint) || !utc(item.resolved_at) || !/^[a-z0-9._-]+$/u.test(item.reason_code) || FORBIDDEN.test(item.reason_code)) throw new Error('gpt_connector_runtime_privacy'); return item; }; const runtime_errors = value.runtime_errors.map(record); const resolutions = value.resolutions.map(resolution); const seen = new Set(); for (const item of [...runtime_errors, ...resolutions]) { if (seen.has(item.fingerprint)) throw new Error('gpt_connector_runtime_schema'); seen.add(item.fingerprint); } if (value.diagnostics.collection === 'disabled') { if (value.diagnostics.status !== 'not_applicable' || high !== 0 || acknowledged !== 0 || next !== 0 || runtime_errors.length || resolutions.length) throw new Error('gpt_connector_runtime_schema'); return { runtime_errors, resolutions, acknowledgement: null }; } if (value.diagnostics.status !== 'ready' || value.diagnostics.pending_count > value.diagnostics.total_count || (runtime_errors.length + resolutions.length > value.diagnostics.total_count)) throw new Error('gpt_connector_runtime_schema'); return { runtime_errors, resolutions, acknowledgement: next > acknowledged ? { product: 'gpt-connector', cursor: next, command: 'gpt-connector', args: ['runtime-errors', 'ack', String(next), '--json'] } : null }; }

async function native(productId, command, args, cwd, now) { const result = await run(command, args, { cwd }); let diagnostic; try { diagnostic = JSON.parse(result.stdout); } catch { return unavailable(result); } return nativeResult(empty(), productId, diagnostic, result, now); }
async function aiterm(cwd, now) { const messages = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dotagents-factory', version: '5.0.0' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnostics', arguments: {} } }]; const result = await run('aiterm-mcp', [], { cwd, input: `${messages.map(JSON.stringify).join('\n')}\n` }); let diagnostic; try { const response = result.stdout.trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.id === 2); diagnostic = JSON.parse(response?.result?.content?.[0]?.text); } catch {} return diagnostic ? nativeResult(empty(), 'aiterm-mcp', diagnostic, result, now) : unavailable(result); }
async function gpt(cwd, now, collectionEnabled) { const result = await run('gpt-connector', ['factory-diagnostics', '--json'], { cwd }); let diagnostic = null; try { diagnostic = JSON.parse(result.stdout); } catch {} let runtime = null; let runtimeFailed = false; if (collectionEnabled) { const snapshot = await run('gpt-connector', ['runtime-errors', 'snapshot', '--after-cursor', '0', '--limit', '256', '--json'], { cwd }); try { if (!snapshot.ok) throw new Error('runtime_snapshot_command'); runtime = JSON.parse(snapshot.stdout); } catch { runtimeFailed = true; } } try { const projection = projectGptConnectorFactory(diagnostic, runtime, result.ok, now); const { acknowledgement, ...safeProjection } = projection; const product = { ...empty(), presence_status: 'installed', ...safeProjection }; if (runtimeFailed) product.checks.push(check('runtime_errors', 'unverified', 'runtime_snapshot_unavailable')); return { product, acknowledgement: runtimeFailed ? null : acknowledgement ?? null }; } catch (error) { return { product: { ...unavailable(result), checks: [check('native_diagnostics', 'unverified', error.message)] }, acknowledgement: null }; } }
async function markitdown(cwd) { const result = await run('markitdown', ['--version'], { cwd }); const installed = result.ok ? version(result.stdout) : null; if (!installed) return unavailable(result, 'version'); const dir = await mkdtemp(join(tmpdir(), 'factory-v4-markitdown-')); try { const fixture = join(dir, 'fixture.txt'); await writeFile(fixture, 'factory fixture\n'); const converted = await run('markitdown', [fixture], { cwd }); return { ...empty(), presence_status: 'installed', installed_version: installed, checks: [check('local_fixture', converted.ok && Buffer.byteLength(converted.stdout) > 0 ? 'pass' : 'unverified', converted.ok ? undefined : 'fixture_failed')] }; } finally { await rm(dir, { recursive: true, force: true }); } }
function tokenizeHookCommand(command) {
  if (typeof command !== 'string') return [];
  const tokens = [];
  for (let index = 0; index < command.length; ) {
    if (command[index] === ' ') {
      index += 1;
      continue;
    }
    if (command[index] === '"') {
      let end = index + 1;
      let value = '';
      while (end < command.length && command[end] !== '"') {
        if (command[end] === '\\' && command[end + 1] === '"') {
          value += '"';
          end += 2;
          continue;
        }
        value += command[end];
        end += 1;
      }
      tokens.push(value);
      index = end + 1;
      continue;
    }
    let end = index;
    while (end < command.length && command[end] !== ' ') end += 1;
    tokens.push(command.slice(index, end));
    index = end;
  }
  return tokens;
}

function posixClaudeHook(posixCommand) {
  const match = /^(?:~\/\.local\/bin\/)([A-Za-z0-9_-]+)(?:\s+(.+))?$/u.exec(posixCommand);
  if (!match) return null;
  return { name: match[1], args: match[2] ? match[2].split(' ') : [] };
}

export function canonicalClaudeHookCommand(command, home, posixCommand) {
  if (command === posixCommand) return true;
  const expected = posixClaudeHook(posixCommand);
  if (!expected || typeof command !== 'string') return false;
  const hookPath = join(home, '.local', 'bin', expected.name);
  let parts = tokenizeHookCommand(command);
  while (parts.length > 0) {
    const first = basename(parts[0]).toLowerCase();
    const wsl = ['bash.exe', 'bash'].includes(first) && parts[0].replaceAll('/', '\\').toLowerCase().includes('system32');
    if (wsl || ['python.exe', 'python3.exe', 'python', 'python3', 'sh.exe', 'bash.exe', 'sh', 'bash', 'cmd.exe'].includes(first)) {
      parts = parts.slice(1);
      continue;
    }
    if ((parts[0] === '/usr/bin/env' || parts[0] === 'env') && parts.length > 1) {
      parts = parts.slice(2);
      continue;
    }
    break;
  }
  if (parts.length !== 1 + expected.args.length) return false;
  return normalize(parts[0]).toLowerCase() === normalize(hookPath).toLowerCase()
    && expected.args.every((argument, index) => parts[index + 1] === argument);
}

function canonicalHookEntry(entry, { matcher, hook }, home) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks) || entry.hooks.length !== 1) return false;
  if (matcher === null ? Object.hasOwn(entry, 'matcher') : entry.matcher !== matcher) return false;
  const candidate = entry.hooks[0];
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && Object.keys(candidate).length === Object.keys(hook).length
    && candidate.type === hook.type
    && candidate.timeout === hook.timeout
    && canonicalClaudeHookCommand(candidate.command, home, hook.command);
}
function posixShellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
function canonicalCodexHookCommand(command, home, subcommand) {
  const hookPath = join(home, '.local', 'bin', 'codex-callout-hook');
  if (process.platform !== 'win32') {
    return command === ['/usr/bin/env', 'python3', hookPath, subcommand].map(posixShellQuote).join(' ');
  }
  if (typeof command !== 'string') return false;
  const match = command.match(/^& "([^"\r\n]+)" "([^"\r\n]+)" "([^"\r\n]+)"$/u);
  if (!match) return false;
  const [, interpreter, script, argument] = match;
  return isAbsolute(interpreter)
    && /^python(?:3(?:\.\d+)?)?\.exe$/iu.test(basename(interpreter))
    && normalize(script).toLowerCase() === normalize(hookPath).toLowerCase()
    && argument === subcommand;
}
async function claudeIntegration(home, now) {
  try {
    const value = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8'));
    const required = {
      PreToolUse: { matcher: 'Agent|Task|Workflow|mcp__codex-sidecar__codex_.*|mcp__aiterm__(codex|grok|composer)_agent', hook: { type: 'command', command: '~/.local/bin/delegation-gate-hook', timeout: 5 } },
      SessionStart: { matcher: null, hook: { type: 'command', command: '~/.local/bin/todo-gate-hook session-start', timeout: 10 } },
      Stop: { matcher: null, hook: { type: 'command', command: '~/.local/bin/todo-gate-hook stop', timeout: 10 } },
      UserPromptSubmit: { matcher: null, hook: { type: 'command', command: '~/.local/bin/onset-gate-hook', timeout: 5 } },
      PostToolUse: { matcher: 'ExitPlanMode', hook: { type: 'command', command: '~/.local/bin/plan-gate-hook', timeout: 5 } },
    };
    for (const [event, expected] of Object.entries(required)) {
      const entries = Array.isArray(value?.hooks?.[event]) ? value.hooks[event] : [];
      const commandMatches = entries.flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : []).filter((item) => canonicalClaudeHookCommand(item?.command, home, expected.hook.command));
      if (commandMatches.length !== 1 || entries.filter((entry) => canonicalHookEntry(entry, expected, home)).length !== 1) throw new Error('required_hooks_missing');
    }
    return { compatibility_status: 'compatible', checks: [check('required_hooks', 'pass')] };
  } catch { return { compatibility_status: 'incompatible', checks: [failure('claude-code', 'required_hooks', 'required_hooks_missing', now)] }; }
}
async function codexIntegration(home, cwd, now) {
  const checks = [];
  let compatible = true;
  const parser = await run('codex', ['features', 'list'], { cwd });
  if (parser.ok) checks.push(check('config_parser', 'pass'));
  else { checks.push(failure('codex-cli', 'config_parser', 'config_parser_failed', now)); compatible = false; }
  try {
    const text = await readFile(join(home, '.codex', 'config.toml'), 'utf8');
    const section = text.match(/^\[features\.multi_agent_v2\](?:[ \t]+#[^\n]*)?[ \t]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/mu)?.[1] || '';
    const features = text.match(/^\[features\](?:[ \t]+#[^\n]*)?[ \t]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/mu)?.[1] || '';
    if (!/^hide_spawn_agent_metadata\s*=\s*false(?:[ \t]+#.*)?[ \t]*$/mu.test(section)
      || !/^tool_namespace\s*=\s*"agents"(?:[ \t]+#.*)?[ \t]*$/mu.test(section)
      || !/^hooks\s*=\s*true(?:[ \t]+#.*)?[ \t]*$/mu.test(features)
      || /^codex_hooks\s*=/mu.test(features)) throw new Error('routing');
    checks.push(check('native_routing', 'pass'));
  } catch { checks.push(failure('codex-cli', 'native_routing', 'native_routing_invalid', now)); compatible = false; }
  try {
    const value = JSON.parse(await readFile(join(home, '.codex', 'hooks.json'), 'utf8'));
    const required = { SessionStart: ['session-start', 10], PreToolUse: ['pre-tool-use', 5], UserPromptSubmit: ['user-prompt-submit', 5], Stop: ['stop', 10] };
    for (const [event, [subcommand, timeout]] of Object.entries(required)) {
      const entries = Array.isArray(value?.hooks?.[event]) ? value.hooks[event] : [];
      const candidates = entries.flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : []).filter((item) => canonicalCodexHookCommand(item?.command, home, subcommand));
      const canonical = entries.filter((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.hasOwn(entry, 'matcher') || !Array.isArray(entry.hooks) || entry.hooks.length !== 1) return false;
        const hook = entry.hooks[0];
        return hook && typeof hook === 'object' && !Array.isArray(hook)
          && Object.keys(hook).length === 5
          && hook.type === 'command'
          && canonicalCodexHookCommand(hook.command, home, subcommand)
          && hook.timeout === timeout
          && hook.async === false
          && hook.statusMessage === null;
      });
      if (candidates.length !== 1 || canonical.length !== 1) throw new Error('hooks');
    }
    checks.push(check('required_hooks', 'pass'));
  } catch { checks.push(failure('codex-cli', 'required_hooks', 'required_hooks_missing', now)); compatible = false; }
  return { compatibility_status: compatible ? 'compatible' : 'incompatible', checks };
}
function withPathPrefix(env, directory) {
  const next = { ...env };
  const key = Object.keys(next).find((entry) => entry.toLowerCase() === 'path') || 'PATH';
  next[key] = `${directory}${delimiter}${next[key] || ''}`;
  return next;
}
async function npmGlobalPathEnv(cwd) {
  if (process.platform === 'win32') {
    const directory = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '';
    if (!directory) return process.env;
    return withPathPrefix(process.env, directory);
  }
  const prefix = await run('npm', ['prefix', '-g'], { cwd });
  if (!prefix.ok) return process.env;
  const bin = prefix.stdout.trim().split(/\r?\n/u)[0];
  if (!bin) return process.env;
  return withPathPrefix(process.env, join(bin, 'bin'));
}
async function npmCli(id, cwd, now) { const spec = NPM_CLI[id]; const env = await npmGlobalPathEnv(cwd); let installedResult = await run(spec.command, ['--version'], { cwd, env }); if (!installedResult.ok || !version(installedResult.stdout)) installedResult = await run(spec.command, ['--version'], { cwd }); const installed = installedResult.ok ? version(installedResult.stdout) : null; const latestResult = await run('npm', ['view', spec.package, 'version', '--json'], { cwd }); let latest = null; try { if (!latestResult.ok) throw new Error('registry_unverified'); latest = parseNpmLatestJson(latestResult.stdout); } catch {} let relation = null; try { if (installed && latest) relation = compareSemver(installed, latest); } catch {} const downgrade = relation !== null && relation > 0; const checks = [check('installed_version', installed ? 'pass' : 'unverified', installed ? undefined : 'cli_unavailable'), check('npm_latest', latest && !downgrade ? 'pass' : 'unverified', downgrade ? 'downgrade_refused' : latest ? undefined : 'registry_unverified')]; let integration = { compatibility_status: 'unverified', checks: [] }; if (installed) integration = id === 'claude-code' ? await claudeIntegration(process.env.HOME || homedir(), now) : await codexIntegration(process.env.HOME || homedir(), cwd, now); return { ...empty(), presence_status: installed ? 'installed' : installedResult.reason === 'spawn' ? 'missing' : 'unverified', ...(installed ? { installed_version: installed } : {}), ...(latest ? { latest_version: latest } : {}), update_status: relation === 0 ? 'current' : relation !== null && relation < 0 ? 'outdated' : 'unverified', compatibility_status: integration.compatibility_status, checks: [...checks, ...integration.checks] }; }
function grokUpdate(value, result) { if (!result.ok && result.reason === 'spawn') return { ...empty(), presence_status: 'not_applicable', checks: [check('stable_update', 'skipped', 'not_applicable')] }; try { if (!result.ok) throw new Error('grok_update_schema'); validateGrokUpdateCheck(value); return { ...empty(), presence_status: 'installed', installed_version: value.currentVersion, latest_version: value.latestVersion, update_status: value.updateAvailable ? 'outdated' : 'current', compatibility_status: 'unverified', checks: [check('stable_update', 'pass')] }; } catch (error) { return { ...empty(), checks: [check('stable_update', 'unverified', error.code ?? error.message)] }; } }
async function grok(cwd) { const result = await run('grok', ['update', '--check', '--json'], { cwd }); let diagnostic; try { diagnostic = JSON.parse(result.stdout); } catch {} return grokUpdate(diagnostic, result); }

function defaultToolchainLedgerPath(targetPlatform) { return targetPlatform === 'win32' ? join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || homedir(), 'AppData', 'Local'), 'dotagents', 'agents-update', 'toolchain-ledger.json') : join(process.env.XDG_STATE_HOME || join(process.env.HOME || homedir(), '.local', 'state'), 'agents-update', 'toolchain-ledger.json'); }
async function readToolchainLedger(path) { try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('toolchain_ledger_permissions'); const value = JSON.parse(await readFile(path, 'utf8')); exact(value, ['schema_version', 'products'], 'toolchain_ledger_schema'); if (value.schema_version !== 'dotagents.toolchain-update.v1' || !value.products || typeof value.products !== 'object' || Array.isArray(value.products)) throw new Error('toolchain_ledger_schema'); const allowed = ['claude-code', 'codex-cli', 'grok-build']; const reasons = ['npm_unavailable', 'install_failed', 'registry_unavailable', 'downgrade_refused', 'post_version_unavailable', 'version_mismatch', 'updated', 'already_current', 'optional_missing', 'check_failed', 'check_schema_invalid', 'update_failed', 'post_contract_failed', 'not_observed']; for (const [id, record] of Object.entries(value.products)) { if (!allowed.includes(id)) throw new Error('toolchain_ledger_schema'); exact(record, ['before_version', 'latest_version', 'operation_status', 'after_version', 'post_gate_status', 'reason_code', 'observed_at'], 'toolchain_ledger_schema'); if (![record.before_version, record.latest_version, record.after_version].every((item) => item === null || semver(item)) || !['success', 'failed', 'skipped', 'pending'].includes(record.operation_status) || !['success', 'failed', 'skipped', 'pending'].includes(record.post_gate_status) || !reasons.includes(record.reason_code) || !utc(record.observed_at)) throw new Error('toolchain_ledger_schema'); } return { value, error: null }; } catch { return { value: null, error: 'toolchain_ledger_unavailable' }; } }
function applyToolchainLedger(product, id, ledger, now) { const projected = { ...product, checks: [...product.checks] }; if (projected.presence_status === 'not_applicable') return projected; if (!ledger.value) { projected.checks.push(check('last_update', 'unverified', ledger.error)); return projected; } const record = ledger.value.products[id]; if (!record) { projected.checks.push(check('last_update', 'unverified', 'toolchain_update_missing')); return projected; } if (record.operation_status === 'failed') { projected.checks.push(failure(id, 'last_update', record.reason_code, now)); return projected; }
  // 更新自体は成功しgateだけ失敗した記録は、この製品の故障ではなく「更新後の健全性が未確認」。
  // failへ丸めるとgate失敗（他製品起因を含む）が全toolchainのfailとして増幅・残響する（2026-08-10実測: 根本3件が9件fail表示）。
  if (record.post_gate_status === 'failed') { projected.checks.push(check('last_update', 'unverified', 'post_gate_failed')); return projected; } if (record.after_version && projected.installed_version && record.after_version !== projected.installed_version) { projected.checks.push(check('last_update', 'unverified', 'toolchain_update_drift')); return projected; } if (['success', 'skipped'].includes(record.operation_status) && record.post_gate_status === 'success') projected.checks.push(check('last_update', 'pass'));
  else projected.checks.push(check('last_update', 'unverified', record.post_gate_status === 'pending' ? 'post_gate_pending' : record.reason_code)); return projected; }

export async function finalizeToolchainReport(report, { expectedReportId, platform = process.platform, toolchainLedgerPath } = {}) {
  if (!expectedReportId || report.report_id !== expectedReportId) throw new Error('finalize_report_mismatch');
  const ledger = await readToolchainLedger(toolchainLedgerPath || defaultToolchainLedgerPath(platform));
  const products = { ...report.products };
  for (const id of ['claude-code', 'codex-cli', 'grok-build']) {
    const product = products[id];
    if (!product) throw new Error(`finalize_product_missing:${id}`);
    products[id] = applyToolchainLedger({ ...product, checks: product.checks.filter((item) => item.check_id !== 'last_update') }, id, ledger, report.observed_at);
  }
  return { ...report, products };
}

export async function scanV5WithAcknowledgements({ host, cwd, arch, platform, collectionEnabled = false, toolchainLedgerPath }) {
  const os = platform === 'win32' ? 'windows' : platform; if (!['darwin', 'linux', 'windows'].includes(os) || !['x64', 'arm64', 'arm', 'ia32'].includes(arch)) throw new Error('platform_or_arch_unsupported');
  const now = new Date().toISOString(); const products = Object.fromEntries(V5_PRODUCT_IDS.map((id) => [id, empty()]));
  products.caveat = await native('caveat', 'caveat', ['factory-diagnostics', '--json', '--require-connector', 'cursor'], cwd, now);
  products.throughline = await native('throughline', 'throughline', ['factory-diagnostics', '--json'], cwd, now);
  products.spotter = await native('spotter', 'spotter', ['diagnostics', 'factory'], cwd, now);
  products['codex-sidecar'] = await native('codex-sidecar', 'codex-sidecar', ['factory-diagnostics', '--project', cwd, '--preset', 'auditor'], cwd, now);
  products['aiterm-mcp'] = await aiterm(cwd, now);
  const gptResult = await gpt(cwd, now, collectionEnabled); products['gpt-connector'] = gptResult.product;
  products.lattice = { ...empty(), ...(await latticeProduct({ cwd }, now)), contract_version: '5.0' };
  products.markitdown = await markitdown(cwd);
  // AIShellはmacOS arm64専用。非対応profileでは構造的なnot_applicableを返し、
  // shell / AppleScript / JXAへ暗黙fallbackしない（wire v5でenroll）。
  products.aishell = { ...empty(), ...(await aishellProduct({ cwd, profile: host.profile }, now)), contract_version: '5.0' };
  let latticeAcknowledgement = null;
  if (collectionEnabled) {
    const projection = await collectLatticeRuntimeErrors({ cwd });
    products.lattice.runtime_errors = projection.runtime_errors;
    products.lattice.resolutions = projection.resolutions;
    latticeAcknowledgement = projection.acknowledgement;
  }
  // contract_versionはwire contract版を一貫して指す。scan.mjsのemptyProduct()はv1期の
  // '1.0'を固定するため、他製品と同じくwire版で上書きする。製品固有のschema版は
  // state_schema_versionが持つ。（v4以前はserverだけ1.0が漏れていた）
  products.servermanager = host.profile === 'server'
    ? { ...empty(), ...(await serverManagerNative({ cwd }, now)), contract_version: '5.0' }
    : { ...empty(), presence_status: 'not_applicable' };
  // Pi5 bridge由来のexternal outage eventはserver hostのv4 reportで還流する（v1と同じmerge契約。
  // v4移行でこの経路が欠落し、bridgeのopen/resolveがBugHubへ届かない実ギャップを6b canaryで検出した）。
  let serverManagerAcknowledgement = null;
  if (host.profile === 'server' && collectionEnabled) {
    const projection = await collectServerManagerExternalEvents({ cwd });
    const merged = mergeServerManagerExternal(products.servermanager, projection);
    products.servermanager = merged.product;
    if (merged.acknowledgement) serverManagerAcknowledgement = merged.acknowledgement;
  }
  const ledger = await readToolchainLedger(toolchainLedgerPath || defaultToolchainLedgerPath(platform));
  products['claude-code'] = applyToolchainLedger(await npmCli('claude-code', cwd, now), 'claude-code', ledger, now); products['codex-cli'] = applyToolchainLedger(await npmCli('codex-cli', cwd, now), 'codex-cli', ledger, now); products['grok-build'] = applyToolchainLedger(await grok(cwd), 'grok-build', ledger, now);
  const revision = await run('git', ['-c', `safe.directory=${REPO_ROOT}`, 'rev-parse', '--short=7', 'HEAD'], { cwd: REPO_ROOT }); if (!revision.ok || !/^[0-9a-f]{7,64}$/u.test(revision.stdout.trim())) throw new Error('dotagents_revision_unavailable');
  const observed = new Date().toISOString(); const created = new Date().toISOString();
  const report = { schema_version: '5.0', report_id: randomUUID(), host_id: host.id, host_profile: host.profile, platform: { os, arch }, report_mode: 'full', observed_at: observed, created_at: created < observed ? observed : created, reporter: { version: '5.0.0', dotagents_revision: revision.stdout.trim() }, products }; return { report, acknowledgements: { schema_version: '5.0', report_id: report.report_id, acknowledgements: [...(gptResult.acknowledgement ? [gptResult.acknowledgement] : []), ...(latticeAcknowledgement ? [latticeAcknowledgement] : []), ...(serverManagerAcknowledgement ? [serverManagerAcknowledgement] : [])] } };
}
export async function scanV5(options) { return (await scanV5WithAcknowledgements(options)).report; }
function utc(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
