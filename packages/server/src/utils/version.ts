import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function getPackageVersion(): string {
  try {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../../../../package.json', '../../package.json', '../../../package.json']) {
      const candidate = path.resolve(dirname, rel);
      if (!fs.existsSync(candidate)) continue;
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      if (pkg.name === 'cortex' || pkg.name === '@cortex/root') return pkg.version;
      if (pkg.version) return pkg.version;
    }
  } catch {
    // Fall through to the safe unknown version for unusual packaging layouts.
  }
  return '0.0.0';
}

export const CURRENT_VERSION = getPackageVersion();
