import fs from 'node:fs';
import { FACTORY_RUNNERS } from './deployment-contract.mjs';

export const RUNNER_PROFILE_PATH = '/etc/dotagents/factory-runner-profile.json';

// Rabbit instances come from the deployment contract; v1 is the single-instance form written before parallel instances.
const SEAT = FACTORY_RUNNERS.find((runner) => runner.label === 'linux-workstation');
export const DEDICATED_INSTANCES = Object.freeze(SEAT.instances.map(({ name, root }) => Object.freeze({
  name, service: `actions.runner.kitepon.${name}.service`, root,
})));

export function parseDedicatedRunnerProfile(source, metadata) {
  if (!metadata.isFile || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new Error('dedicated runner profile must be a root-owned regular file without group/other write access');
  }
  const value = JSON.parse(source);
  const common = { mode: 'dedicated', user: 'factory-runner', label: SEAT.label };
  for (const [key, wanted] of Object.entries(common)) {
    if (value[key] !== wanted) throw new Error(`invalid dedicated runner profile field: ${key}`);
  }
  let instances;
  if (value.schema === 'dotagents.runner-profile.v1') {
    const [first] = DEDICATED_INSTANCES;
    for (const key of ['name', 'service', 'root']) {
      if (value[key] !== first[key]) throw new Error(`invalid dedicated runner profile field: ${key}`);
    }
    instances = [first];
  } else if (value.schema === 'dotagents.runner-profile.v2') {
    if (JSON.stringify(value.instances) !== JSON.stringify(DEDICATED_INSTANCES)) {
      throw new Error('invalid dedicated runner profile field: instances');
    }
    instances = DEDICATED_INSTANCES;
  } else {
    throw new Error('invalid dedicated runner profile field: schema');
  }
  if (value.state !== 'active') throw new Error('dedicated runner profile is not active');
  return { ...common, state: 'active', instances: instances.map((item) => ({ ...item })) };
}

export function readRunnerProfile(path = RUNNER_PROFILE_PATH) {
  let initial;
  try { initial = fs.lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return { mode: 'legacy' };
    throw error;
  }
  if (!initial.isFile() || initial.uid !== 0 || (initial.mode & 0o022) !== 0) {
    throw new Error('dedicated runner profile must be a root-owned regular file without group/other write access');
  }
  let descriptor;
  descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    const metadata = { isFile: stat.isFile(), uid: stat.uid, mode: stat.mode };
    if (!metadata.isFile || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error('dedicated runner profile must be a root-owned regular file without group/other write access');
    }
    return parseDedicatedRunnerProfile(fs.readFileSync(descriptor, 'utf8'), metadata);
  } finally { fs.closeSync(descriptor); }
}
