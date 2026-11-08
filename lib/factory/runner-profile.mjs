import fs from 'node:fs';
import { FACTORY_RUNNERS } from './deployment-contract.mjs';

export const RUNNER_PROFILE_PATH = '/etc/dotagents/factory-runner-profile.json';

// Rabbit pool from the deployment contract. v1 = one instance, v2 = fixed per-instance units (a prefix of the pool,
// written 2026-11-08 before the scaler), v3 = the whole pool under the one scaler unit.
const SEAT = FACTORY_RUNNERS.find((runner) => runner.label === 'linux-workstation');
export const SCALER_SERVICE = 'factory-runner-scaler.service';
export const DEDICATED_INSTANCES = Object.freeze(SEAT.instances.map(({ name, root }) => Object.freeze({
  name, service: `actions.runner.kitepon.${name}.service`, root,
})));
export const POOL_INSTANCES = Object.freeze(SEAT.instances.map(({ name, root }) => Object.freeze({ name, root })));

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
    const count = Array.isArray(value.instances) ? value.instances.length : 0;
    if (!count || JSON.stringify(value.instances) !== JSON.stringify(DEDICATED_INSTANCES.slice(0, count))) {
      throw new Error('invalid dedicated runner profile field: instances');
    }
    instances = DEDICATED_INSTANCES.slice(0, count);
  } else if (value.schema === 'dotagents.runner-profile.v3') {
    if (value.service !== SCALER_SERVICE) throw new Error('invalid dedicated runner profile field: service');
    if (JSON.stringify(value.instances) !== JSON.stringify(POOL_INSTANCES)) {
      throw new Error('invalid dedicated runner profile field: instances');
    }
    instances = POOL_INSTANCES.map((item) => ({ ...item, service: SCALER_SERVICE }));
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
