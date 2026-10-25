'use strict';
(async () => {
// Only filesystem inventory and identified Node --version. Never start Caveat or an AI CLI.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const home = os.homedir();
const now = () => new Date().toISOString();
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
const out = { started_at: now(), os: process.platform, arch: process.arch,
  collector_runtime: { executable: process.execPath, version: process.version },
  harnesses: [], packages: [], nodes: [], saved_factory: null,
  caveat_or_harness_started: false, network_or_auth_probes: false,
  settings_or_credentials_written: false, healthy: null };
function findCommand(command, envPath = process.env.PATH || '') {
  if (typeof command !== 'string') return null;
  if (path.isAbsolute(command)) return exists(command) ? command : null;
  for (const dir of envPath.split(path.delimiter)) {
    for (const ext of process.platform === 'win32' ? ['', '.exe', '.cmd', '.ps1'] : ['']) {
      const p = path.join(dir, command + ext);
      if (exists(p)) return p;
    }
  }
  return null;
}
const nodePaths = new Set([real(process.execPath)]);
function nodeVersion(p) {
  p = real(p);
  if (!p || !/^node(?:\.exe)?$/i.test(path.basename(p))) return null;
  const old = out.nodes.find(n => n.executable === p);
  if (old) return old;
  const r = cp.spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 5000,
    maxBuffer: 4096, windowsHide: true });
  const v = (r.stdout || '').trim();
  const row = { executable: p, observed_at: now(), version: r.status === 0 && /^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v) ? v.slice(1) : null,
    exit_code: r.status, purpose: 'runtime version only; no Caveat or harness executed' };
  out.nodes.push(row); return row;
}
const roots = new Set();
function addRoot(p) {
  p = real(p); if (!p) return;
  const file = path.join(p, 'package.json');
  if (!exists(file)) return;
  try { if (readJSON(file).name === 'caveat-cli') roots.add(p); } catch {}
}
const managed = new Map();
async function rootForFile(p) {
  p = real(p); if (!p) return null;
  const expected = [path.join(real(home),'.caveat-deploy','managed-v1','entry','caveat.mjs'),path.join(real(home),'.local','share','caveat','managed-v1','entry','caveat.mjs')];
  if (expected.includes(p)) {
    if (managed.has(p)) return managed.get(p).package_root;
    try {
      // The public fixed runtime is a side-effect-free metadata reader: no CLI,
      // SQLite, provider, worker or installer is started by this import.
      const entry = path.dirname(p), root = path.dirname(entry);
      const reader=path.join(entry,'managed-deployment.js');
      const known=expected.indexOf(p)===0
        ? ['e92fcf27564e0ebab94580d052b8ba1b5ac072dabcb970cadf96844d66fe96b9','a2ee8713c81297f3d46b4ded214c4206dab9841a933e16bd9a35e67337365cc4']
        : ['6e39713485eec74d8348f9a20d6b720c8a47ea5b7c485348953ca96031f284d8','553762cc5e180c0da3ef856150530e9b7ba225ed0a6537afd1fd6e07aceab738'];
      for(const [file,expectedHash] of [[p,known[0]],[reader,known[1]]]){
        const stat=fs.lstatSync(file);
        if(!stat.isFile()||stat.isSymbolicLink()||sha(fs.readFileSync(file))!==expectedHash)throw Error('managed_unknown_entry_protocol');
      }
      const module = await import(require('node:url').pathToFileURL(reader).href);
      const data = typeof module.readManagedDeploymentAtRoot === 'function' ? module.readManagedDeploymentAtRoot(root) : module.readManagedDeployment({userHome:home});
      const record = {launcher:p,root,package_root:data.packageRoot,release:data.pointer.release,version:data.manifest.version,manifest_sha256:data.pointer.manifestSha256,
        pointer_sha256:sha(fs.readFileSync(path.join(root,'active.json'))),entry_sha256:sha(fs.readFileSync(p)),runtime_sha256:sha(fs.readFileSync(path.join(entry,'managed-deployment.js'))),consistent:true};
      const pkg=readJSON(path.join(data.packageRoot,'package.json'));
      if(pkg.name!=='caveat-cli'||pkg.version!==record.version)throw Error('managed_package_version_mismatch');
      managed.set(p,record);addRoot(data.packageRoot);return data.packageRoot;
    } catch(error) {
      out.managed_deployment_errors ??= [];
      out.managed_deployment_errors.push({launcher:p,diagnostic:error.code || (error instanceof SyntaxError ? 'invalid_managed_metadata_json' : /^managed_/.test(error.message)?error.message:'managed_metadata_unavailable')});
      // A managed definition that cannot be verified never falls back to a
      // globally installed package, which could falsely report the old version.
      throw Error('managed_metadata_refused');
    }
  }
  let dir = path.dirname(p);
  for (let n = 0; n < 5; n++, dir = path.dirname(dir)) {
    const f = path.join(dir, 'package.json');
    try { if (exists(f) && readJSON(f).name === 'caveat-cli') { addRoot(dir); return dir; } } catch {}
  }
  return null;
}
for (const p of [path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'caveat-cli'),
  path.join(path.dirname(process.execPath), 'node_modules', 'caveat-cli'),
  path.join(home, '.npm-global/lib/node_modules/caveat-cli'),
  path.join(home, '.local/lib/node-v24/lib/node_modules/caveat-cli'),
  path.join(home, 'AppData/Roaming/npm/node_modules/caveat-cli'),
  '/opt/homebrew/lib/node_modules/caveat-cli', '/usr/local/lib/node_modules/caveat-cli']) addRoot(p);
try { for (const n of fs.readdirSync(path.join(home, '.nvm/versions/node'))) addRoot(path.join(home, '.nvm/versions/node', n, 'lib/node_modules/caveat-cli')); } catch {}
const command = findCommand('caveat'); if (command) await rootForFile(command);
function parseTomlCaveat(text) {
  for (const root of roots) {
    try {
      const req = require('node:module').createRequire(path.join(root, 'package.json'));
      return req('smol-toml').parse(text).mcp_servers?.caveat || null;
    } catch {}
  }
  const match = text.match(/^\[mcp_servers\.caveat\]\s*\r?\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  if (!match) return null;
  const section = match[1];
  const field = key => {
    const m = section.match(new RegExp('^\\s*' + key + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\]|true|false)', 'm'));
    if (!m) return undefined;
    try { return JSON.parse(m[1]); } catch { return undefined; }
  };
  return { command: field('command'), args: field('args'), enabled: field('enabled'),
    env: undefined, toml_parser_scope: 'only literal command/args/enabled in caveat table; env not read' };
}
const configs = [
  ['claude', process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json'), 'json', 'mcpServers'],
  ['codex', path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), 'toml', 'mcp_servers'],
  ['grok', path.join(process.env.GROK_HOME || path.join(home, '.grok'), 'config.toml'), 'toml', 'mcp_servers'],
  ['cursor', path.join(process.env.CURSOR_HOME || path.join(home, '.cursor'), 'mcp.json'), 'json', 'mcpServers']];
for (const [name, file, format, key] of configs) {
  const row = { name, config_file: file, config_present: exists(file), observed_at: now() };
  if (row.config_present) try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const config = format === 'json' ? JSON.parse(text)[key]?.caveat : parseTomlCaveat(text);
    row.caveat_registration_present = !!config;
    if (config) {
      row.enabled = config.enabled !== false;
      const args = Array.isArray(config.args) ? config.args : [];
      const envPath = format === 'json' && typeof config.env?.PATH === 'string' ? config.env.PATH : process.env.PATH;
      const executable = findCommand(config.command, envPath);
      row.command_basename = typeof config.command === 'string' ? path.basename(config.command) : null;
      row.command_file = executable;
      row.command_realpath = executable ? real(executable) : null;
      row.package_roots = [];
      if (executable) {
        const root = await rootForFile(executable); if (root) row.package_roots.push(root);
        if (/^node(?:\.exe)?$/i.test(path.basename(executable))) nodePaths.add(executable);
      }
      row.caveat_argument_files = [];
      for (const a of args) if (typeof a === 'string' && /caveat/i.test(a) && !/[\r\n]/.test(a) && path.isAbsolute(a) && exists(a)) {
        row.caveat_argument_files.push(a);
        const root = await rootForFile(a); if (root && !row.package_roots.includes(root)) row.package_roots.push(root);
      }
      const canonicalLauncher=path.join(real(home),'.caveat-deploy','managed-v1','entry','caveat.mjs');
      row.managed_mcp_argument_contract = JSON.stringify(args)===JSON.stringify(['--disable-warning=ExperimentalWarning',canonicalLauncher,'mcp-server']);
      row.config_sha256=sha(fs.readFileSync(file));
      row.node_runtime_binding = row.command_basename && /^node(?:\.exe)?$/i.test(row.command_basename)
        ? 'configured Node command resolved in inventory environment; harness effective environment not launched'
        : 'shebang or shim interpreter not proven from path alone';
      row.environment_values_disclosed = false;
      row.effective_harness_runtime_verified = false;
    }
  } catch { row.read_status = 'unparsed'; }
  out.harnesses.push(row);
}
for (const p of nodePaths) if (p) nodeVersion(p);
for (const root of [...roots].sort()) {
  const manifestFile = path.join(root, 'package.json'); const manifest = readJSON(manifestFile);
  const files = []; const missing = []; let total = 0; let bounded = true;
  function walk(p) {
    if (files.length >= 8192 || total > 128 * 1024 * 1024) { bounded = false; return; }
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { missing.push(path.relative(root, p)); return; }
    if (st.isDirectory()) { for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name)); }
    else if (st.isFile()) {
      const b = fs.readFileSync(p); total += b.length;
      files.push({ path: path.relative(root, p).replace(/\\/g, '/'), bytes: b.length, sha256: sha(b) });
    }
  }
  for (const name of ['package.json', 'dist', 'node_modules']) {
    const p = path.join(root, name); if (fs.existsSync(p)) walk(p);
    else if (name !== 'node_modules') missing.push(name);
  }
  files.sort((a,b) => a.path.localeCompare(b.path, 'en'));
  const installedExternal = []; const unresolvedExternal = [];
  const seen = new Set();
  function external(parent, name) {
    let dir = parent; let file = null;
    while (dir.startsWith(root)) {
      const candidate = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
      if (exists(candidate)) { file = candidate; break; }
      const next = path.dirname(dir); if (next === dir) break; dir = next;
    }
    if (!file) { unresolvedExternal.push(name); return; }
    file = real(file); if (seen.has(file)) return; seen.add(file);
    try {
      const raw = fs.readFileSync(file); const p = JSON.parse(raw);
      installedExternal.push({ name: p.name, version: p.version, package_json: file,
        manifest_sha256: sha(raw), evidence: 'installed_external_package_manifest' });
      for (const n of Object.keys(p.dependencies || {})) external(path.dirname(file), n);
    } catch { unresolvedExternal.push(name); }
  }
  for (const n of Object.keys(manifest.dependencies || {})) external(root, n);
  const bundled = new Map(); const maps = files.filter(f => f.path.startsWith('dist/') && f.path.endsWith('.map'));
  for (const m of maps) try {
    const map = readJSON(path.join(root, m.path));
    for (const s of map.sources || []) {
      const matched = s.match(/node_modules\/[.]pnpm\/((?:@[^+@/]+\+)?[^@/]+)@(\d+\.\d+\.\d+(?:-[^_/]+)?)[^/]*\/node_modules\//);
      if (matched) {
        const name = matched[1].startsWith('@') ? matched[1].replace('+', '/') : matched[1];
        const key = name + '@' + matched[2];
        const row = bundled.get(key) || { name, version: matched[2], source_map_files: [], evidence: 'versioned_source_paths_in_installed_bundle_map' };
        if (!row.source_map_files.includes(m.path)) row.source_map_files.push(m.path);
        bundled.set(key, row);
      }
    }
  } catch { missing.push(m.path + ':unparsed'); }
  out.packages.push({ root, observed_at: now(), installed_version: manifest.version,
    registered_harnesses: out.harnesses.filter(h => h.package_roots?.includes(root)).map(h => h.name),
    files, bytes_hashed: total, file_inventory_bounded: bounded,
    symlink_or_missing_entries: missing,
    deployment_revision_candidate: bounded && missing.length === 0 ? 'installed-sha256:' + sha(JSON.stringify(files)) : null,
    revision_scope: 'actual installed package content identity; source commit and running process identity not inferred',
    source_revision: typeof manifest.gitHead === 'string' ? manifest.gitHead : null,
    external_dependencies: installedExternal, unresolved_external_dependencies: [...new Set(unresolvedExternal)],
    bundled_dependencies: [...bundled.values()].sort((a,b) => (a.name+a.version).localeCompare(b.name+b.version)),
    bundled_dependency_closure_complete: false,
    closure_limitation: 'source-map version paths identify bundled packages; unused paths and dynamic/runtime external imports not proven',
    healthy: null });
}
out.managed_deployments=[...managed.values()];
for (const entry of out.managed_deployments) {
  try { entry.consistent = entry.pointer_sha256===sha(fs.readFileSync(path.join(entry.root,'active.json'))) && entry.entry_sha256===sha(fs.readFileSync(entry.launcher)) && entry.runtime_sha256===sha(fs.readFileSync(path.join(path.dirname(entry.launcher),'managed-deployment.js'))); }
  catch { entry.consistent=false; }
  for(const pkg of out.packages.filter(p=>p.root===entry.package_root)) {
    if(!entry.consistent)pkg.deployment_revision_candidate=null;
    else if(pkg.deployment_revision_candidate)pkg.deployment_revision_candidate='managed-installed-sha256:'+sha(JSON.stringify({payload:pkg.deployment_revision_candidate,entry}));
    pkg.managed_entry_verified=entry.consistent;
    pkg.revision_scope='installed payload plus fixed entry/runtime and selected pointer identity; running process health not inferred';
  }
}
const reports = [path.join(home, '.local/state/dotagents/factory-reporter-v9/latest-report.json'),
  path.join(home, 'AppData/Local/dotagents/factory-reporter-v9/latest-report.json')];
for (const p of reports) if (exists(p)) try {
  const r = readJSON(p); const product = r.products?.caveat;
  if (product) out.saved_factory = { path: p, report_id: r.report_id, host_id: r.host_id,
    observed_at: r.observed_at,
    product: { installed_version: product.installed_version, presence_status: product.presence_status,
      compatibility_status: product.compatibility_status,
      checks: (product.checks || []).map(c => ({check_id: c.check_id, status: c.status, reason_code: c.reason_code})),
      runtime_errors_count: (product.runtime_errors || []).length,
      resolutions_count: (product.resolutions || []).length },
    evidence_scope: 'saved diagnostic report; not a newly invoked diagnostic' };
} catch {}
for(const h of out.harnesses)if(h.config_sha256){try{h.config_consistent=h.config_sha256===sha(fs.readFileSync(h.config_file));}catch{h.config_consistent=false;}}
out.finished_at = now();
process.stdout.write(JSON.stringify(out));

})().catch(error=>{console.error(error.code || 'inventory_read_failed');process.exitCode=1;});
