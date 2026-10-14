/**
 * Test scratch space. Every temporary path lives under the repository's
 * gitignored `.scratch/` directory, never a tmpfs, so a failing run leaves its
 * evidence behind instead of losing it on reboot.
 *
 * @module dsh-paseo-server/tests/scratch
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

/** Absolute path of the repository scratch root. */
export const SCRATCH_ROOT = join(import.meta.dirname, '..', '.scratch')

/** Create one fresh scratch directory. */
export function scratchDir(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true })
  return mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`))
}
