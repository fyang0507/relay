// `relay shutdown` — stop the daemon and remove the plist. Inverse of init.
//
// Like init, this module is pure presentation: it delegates to
// lifecycle.uninstall() and renders the LifecycleResult. ~/.relay/ is
// intentionally preserved (see lifecycle.ts).

import { uninstall, type LifecycleOptions, type LifecycleResult } from './lifecycle.ts';
import { printKv } from './output.ts';
import { CliError } from './errors.ts';

export interface ShutdownCommandOpts {
  lifecycle?: LifecycleOptions;
}

export async function runShutdown(opts: ShutdownCommandOpts = {}): Promise<void> {
  let result: LifecycleResult;
  try {
    result = await uninstall(opts.lifecycle);
  } catch (err) {
    throw new CliError(
      [`Error: relay shutdown failed — ${(err as Error).message}`],
      1,
    );
  }

  const kv: Array<[string, string]> = [
    ['status', result.status],
    ['label', result.label],
  ];
  if (result.detail) kv.push(['detail', result.detail]);
  printKv(kv);
}
