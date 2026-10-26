import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Only an absent ownership marker permits the legacy npm/init writer.
export function caveatUpdateOwner({ home = homedir(), inspect = lstatSync } = {}) {
  const parent = join(home, '.caveat-deploy');
  try {
    if (!inspect(parent).isDirectory()) return 'unknown:deployment-parent';
  } catch (error) {
    return error.code === 'ENOENT' ? 'factory' : `unknown:${error.code ?? 'stat'}`;
  }
  try {
    inspect(join(parent, 'managed-v1'));
    return 'managed-v1';
  } catch (error) {
    return error.code === 'ENOENT' ? 'factory' : `unknown:${error.code ?? 'stat'}`;
  }
}
