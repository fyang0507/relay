// `relay init` — install the launchd plist and bring the daemon up.
//
// Pure presentation layer: hands off to lifecycle.install() and renders the
// resulting LifecycleResult as a kv block. All lifecycle policy
// (idempotence, health probing, upgrade path) lives in lifecycle.ts.

import { install, type LifecycleOptions, type LifecycleResult } from './lifecycle.ts';
import { resolvePaths } from './lifecycle.ts';
import { printKv } from './output.ts';
import { CliError } from './errors.ts';

export interface InitCommandOpts {
  // Forwarded to install(); kept as an opaque LifecycleOptions so tests can
  // inject a stub launchctlExec + healthClient without this module knowing
  // the details.
  lifecycle?: LifecycleOptions;
}

export async function runInit(opts: InitCommandOpts = {}): Promise<void> {
  let result: LifecycleResult;
  try {
    result = await install(opts.lifecycle);
  } catch (err) {
    throw new CliError([`Error: relay init failed — ${(err as Error).message}`], 1);
  }

  // `install()` only returns 'installed' or 'already-installed' on success;
  // the other statuses belong to uninstall(). Defensive normalization: any
  // status other than 'installed' / 'already-installed' still renders
  // without crashing, but we surface it verbatim.
  const paths = resolvePaths(opts.lifecycle?.paths);
  const kv: Array<[string, string]> = [
    ['status', result.status],
    ['label', result.label],
    ['plist', result.plistPath],
    ['socket', paths.socketPath],
  ];
  if (result.detail) kv.push(['detail', result.detail]);
  printKv(kv);
}
