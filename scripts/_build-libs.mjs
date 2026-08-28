/**
 * Compiles the TypeScript libs these scripts share into CommonJS so plain
 * `node` can require them.
 *
 * The scripts deliberately use the application's own detection code rather
 * than a copy — a repair that detects brands differently from the pipeline
 * would drift the moment it ran. Node cannot import the .ts sources directly
 * (they use extensionless relative imports, which ESM will not resolve), so
 * they are built to a temp directory on demand.
 */
import { execSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

export function buildLibs(files = ['lib/brandDetection.ts', 'lib/handles.ts']) {
  const out = mkdtempSync(path.join(tmpdir(), 'inf-libs-'));
  execSync(
    `npx tsc ${files.join(' ')} --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
    { stdio: 'pipe' }
  );
  return out;
}
