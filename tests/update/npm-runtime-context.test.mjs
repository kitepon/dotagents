import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const writer = readFileSync(new URL('../../bin/agents-update.sh', import.meta.url), 'utf8');
const entry = writer.slice(writer.indexOf('run_npm() ('), writer.indexOf('\nresolve_npm_global_bin() {'));
const id = '00000000-0000-4000-8000-000000000001';
const fixture = body => {
  const root = mkdtempSync(join(tmpdir(), 'npm-runtime-'));
  const posix = value => value.replaceAll('\\', '/');
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\n' + body, { mode: 0o700 });
  const log = join(root, 'agents-update.log');
  return { root, bin, log, run(command, env = {}) {
    return spawnSync('bash', ['-c', 'set -uo pipefail\n' + entry + '\n' + command], {
      encoding: 'utf8', env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
        LOG: posix(log), AGENTS_UPDATE_BATCH_TOKEN: id, ...env },
    });
  }, text() { return readFileSync(log, 'utf8'); }, close() { rmSync(root, { recursive: true, force: true }); } };
};

test('normal npm stdout, argv and failure survive selective startup logging', () => {
  const f = fixture(`printf '%s\\n' 'npm verbose cli /actual/node /actual/npm-cli.js' 'npm info using npm@11.8.0' 'npm info using node@v24.22.1' 'npm verbose argv secret-token' 'npm error ordinary failure' >&2
printf '"1.2.3"\\n'
[[ "$*" = 'view @example/tool version --json' ]] || exit 99
exit 37
`);
  try {
    const result = f.run('run_npm view @example/tool version --json');
    assert.equal(result.status, 37); assert.equal(result.stdout, '"1.2.3"\n');
    assert.equal(result.stderr, 'npm error ordinary failure\n');
    const text = f.text(); assert.match(text, /cli \/actual\/node \/actual\/npm-cli.js/u);
    assert.match(text, /node@v24\.22\.1/u); assert.match(text, /end exit=37/u);
    assert.equal((text.match(/ start /gu) ?? []).length, 1); assert.ok(!text.includes('secret-token'));
  } finally { f.close(); }
});

test('the actual npm child startup changes after the global-bin PATH prepend', () => {
  const f = fixture(`printf '%s\\n' 'npm verbose cli /initial/node /initial/npm-cli.js' 'npm info using node@v24.22.1' >&2
printf 'prefix\\n'
`);
  try {
    const after = join(f.root, 'after'); mkdirSync(after);
    writeFileSync(join(after, 'npm'), `#!/usr/bin/env bash
printf '%s\\n' 'npm verbose cli C:\\Program Files\\nodejs\\node.exe C:\\Program Files\\npm\\npm-cli.js' 'npm info using node@v26.12.1' >&2
printf '"2.3.4"\\n'
`, { mode: 0o700 });
    const result = f.run('before="$(run_npm prefix -g)"\nPATH="$AFTER_BIN:$PATH"\nafter="$(run_npm view package version --json 2>/dev/null)"\nprintf "%s|%s" "$before" "$after"', { AFTER_BIN: after.replaceAll('\\', '/') });
    assert.equal(result.status, 0); assert.equal(result.stdout, 'prefix|"2.3.4"');
    const text = f.text(); assert.match(text, /\/initial\/node/u);
    assert.ok(text.includes('C:\\Program Files\\nodejs\\node.exe')); assert.match(text, /node@v26\.12\.1/u);
    assert.equal((text.match(/ start /gu) ?? []).length, 2);
    const starts = text.split('\n').filter(line => line.includes(' start '));
    assert.notEqual(starts[0].split(' ')[1], starts[1].split(' ')[1]);
  } finally { f.close(); }
});

test('only presence is logged for inherited CA settings and invalid batch identifiers', () => {
  const f = fixture('printf done');
  try {
    const result = f.run('run_npm install -g package', { NODE_EXTRA_CA_CERTS: '/secret-token.pem',
      NODE_OPTIONS: '--require secret-token', AGENTS_UPDATE_BATCH_TOKEN: 'secret-token' });
    assert.equal(result.status, 0); assert.equal(result.stdout, 'done');
    const text = f.text(); assert.match(text, /batch_token=unknown/u);
    assert.match(text, /NODE_EXTRA_CA_CERTS=true/u); assert.match(text, /NODE_OPTIONS=true/u);
    assert.ok(!text.includes('secret-token')); assert.ok(!text.includes('node@'));
  } finally { f.close(); }
});

test('colored startup logs are classified while verbose argv never reach output or the saved record', () => {
  const f = fixture(`printf '\\033[36mnpm verbose cli /actual/node /actual/npm-cli.js\\033[0m\\r\\n' >&2
printf '\\033[36mnpm verbose argv secret-token\\033[0m\\n' >&2
`);
  try {
    const result = f.run('run_npm view package version --json');
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.match(f.text(), /cli \/actual\/node/u); assert.ok(!f.text().includes('secret-token'));
  } finally { f.close(); }
});

test('unwritable evidence output never turns an npm failure into success', () => {
  const f = fixture('printf payload; exit 23');
  try {
    const result = f.run('run_npm install -g package', { LOG: join(f.root, 'absent', 'log').replaceAll('\\', '/') });
    assert.equal(result.status, 23); assert.equal(result.stdout, 'payload');
  } finally { f.close(); }
});

test('malformed public version fields are not retained as runtime evidence', () => {
  const f = fixture(`printf '%s\\n' 'npm info using node@v24.22.1 secret-token' 'npm info using npm@https://secret-token' >&2\n`);
  try {
    const result = f.run('run_npm view package version --json');
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.ok(!f.text().includes('secret-token')); assert.ok(!f.text().includes('node@'));
  } finally { f.close(); }
});

test('an existing npm shell function keeps its selection and original result', () => {
  const f = fixture('exit 99');
  try {
    const result = f.run('npm() { printf selected-function; return 17; }\nrun_npm install -g package');
    assert.equal(result.status, 17); assert.equal(result.stdout, 'selected-function');
    assert.match(f.text(), /npm_kind=function/u); assert.match(f.text(), /end exit=17/u);
  } finally { f.close(); }
});
