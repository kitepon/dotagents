#!/usr/bin/env node
// Helper for the Rabbit rootless-Docker apply script and the setup check. Reads stdin where noted; prints to stdout.
//   config        service<TAB>socket<TAB>DOCKER_HOST
//   unit [script] the factory-runner-dockerd.service unit text (script: the Engine's dockerd-rootless.sh path, default docker-ce's)
//   scripts       engine<TAB>launcher path, one line per supported Engine
//   set-env <root> stdin = that root's .env -> the same file with exactly one DOCKER_HOST line and HOME=<root>/home
//   has-env <root> stdin = that root's .env -> exit 0 only with exactly the expected DOCKER_HOST and HOME lines
//   subid-start   stdin = /etc/subuid or /etc/subgid -> first free id; exit 3 when factory-runner already has a range
import fs from 'node:fs';
import {
  DOCKER_HOST, DOCKER_SERVICE, DOCKER_SOCKET, ROOTLESS_SCRIPTS, hasRootEnv, hasSubidRange, nextSubidStart, renderDockerdUnit, rootHome, setRootEnv,
} from '../lib/factory/runner-docker.mjs';

const stdin = () => fs.readFileSync(0, 'utf8');
const command = process.argv[2];
if (process.argv.length < 3 || process.argv.length > (['unit', 'set-env', 'has-env'].includes(command) ? 4 : 3)) { console.error('FAIL: usage: factory-runner-docker.mjs config|unit [script]|scripts|set-env <root>|has-env <root>|subid-start'); process.exit(2); }
switch (command) {
  case 'config': console.log([DOCKER_SERVICE, DOCKER_SOCKET, DOCKER_HOST].join('\t')); break;
  case 'unit':
    try { process.stdout.write(renderDockerdUnit(process.argv[3])); } catch (error) { console.error(`FAIL: ${error.message}`); process.exit(2); }
    break;
  case 'scripts': for (const [engine, script] of Object.entries(ROOTLESS_SCRIPTS)) console.log(`${engine}\t${script}`); break;
  case 'set-env': case 'has-env': {
    const root = process.argv[3];
    try { rootHome(root); } catch (error) { console.error(`FAIL: ${error.message}`); process.exit(2); }
    if (command === 'set-env') process.stdout.write(setRootEnv(stdin(), root));
    else process.exit(hasRootEnv(stdin(), root) ? 0 : 1);
    break;
  }
  case 'subid-start': {
    const source = stdin();
    if (hasSubidRange(source)) process.exit(3);
    console.log(nextSubidStart(source));
    break;
  }
  default: console.error(`FAIL: unknown command: ${command}`); process.exit(2);
}
