/**
 * Shared helpers for the repository guards.
 *
 * The guards read the index rather than the working tree: `git ls-files` is what a pull request
 * actually carries, and a file that is not tracked cannot leak or drift.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(__dirname, '..', '..');

export function trackedFiles(...paths: string[]): string[] {
  const args = ['ls-files', '-z', '--', ...(paths.length > 0 ? paths : ['.'])];
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
}

/**
 * The glob subset `.sync-manifest.json` uses: `**` crosses directory boundaries, `*` stops at one,
 * everything else is literal. Deliberately small - a manifest nobody can read by eye is a manifest
 * nobody checks.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

export function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')) as T;
}
