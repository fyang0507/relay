// Skills-sync primitive used by both `relay setup` and the build-time
// scripts/sync-skills.mjs wrapper. Copies the canonical skill docs
// (skills/relay-integration/) into <data_repo>/.agents/skills/relay/ so the
// agent's workspace always has docs matching the currently installed relay
// build.
//
// Plain recursive cp. Existing files under dest are overwritten — skills
// are authoritative from the relay repo, not edited in place in the data
// repo. Destination directory is created if missing.

import { cpSync, existsSync, mkdirSync } from 'node:fs';

export interface SyncSkillsResult {
  source: string;
  destination: string;
}

export function syncSkills(sourceDir: string, destDir: string): SyncSkillsResult {
  if (!existsSync(sourceDir)) {
    throw new Error(`Skills source directory not found: ${sourceDir}`);
  }
  mkdirSync(destDir, { recursive: true });
  cpSync(sourceDir, destDir, { recursive: true });
  return { source: sourceDir, destination: destDir };
}
