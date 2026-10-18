/**
 * Environment for the examples, from two files with two different jobs.
 *
 *   ../../.env        credentials and SDK configuration, from .env.template.
 *   ../demo.env       the demo's own fixtures - the tenant, the team, the agent, from
 *                     demo.env.template.
 *
 * Both are git-ignored and both are optional: a missing file is a no-op for dotenv, and every
 * fixture has the same value as its default in `demo-env.ts`, so the examples run on a fresh
 * clone with neither file present - against the built-in mocks, since there is no key either,
 * which is also the only mode those defaults apply in. Supply a real `STIGG_API_KEY` and the
 * fixtures stop defaulting: see `demo-env.ts` for what each one's absence then costs.
 *
 * The split is the point: everything in `demo.env` is something a real application already knows
 * from its own session and would never read from an env file. Keeping it out of `.env` stops it
 * being mistaken for configuration you are meant to set.
 *
 * `.env` is loaded first and dotenv never overwrites an existing value, so anything you put there
 * (or export in your shell) still wins over the demo fixtures.
 *
 * Import this instead of `dotenv/config` - it must run before anything reads `process.env`.
 */
import { config } from 'dotenv';
import { join } from 'node:path';

// Package root: credentials + SDK config.
config({ path: join(__dirname, '..', '..', '.env') });
// Examples directory: demo fixtures.
config({ path: join(__dirname, '..', 'demo.env') });
