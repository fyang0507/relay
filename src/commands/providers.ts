// Shared provider wiring helper. Builds the map of `provider string →
// Provider instance` that both dispatch and runtime consume.
//
// Key invariants:
//  - The map key is the exact `provider` string used in `SourceConfig.provider`
//    (i.e. 'stdout', 'telegram'), which is what dispatch.ts and runtime.ts
//    look up when handling lines and provisioning.
//  - `stdout` is always available — it's the dry-run provider and costs nothing
//    to include.
//  - Telegram is instantiated only when `credentials.telegram` is present.
//    The update_id cursor is read/written through the state store so the
//    provider stays side-effect-free w.r.t. disk.
//
// Phase 2 split: credentials come from `.env` (see src/credentials.ts), not
// from the project config file. Sources address their destination chat id
// directly via `SourceConfig.groupId`, so the telegram provider no longer
// needs a `groups` name→id map here.

import type { Credentials } from '../credentials.ts';
import type { RelayState } from '../state.ts';
import type { Provider } from '../providers/types.ts';
import { StdoutProvider } from '../providers/stdout.ts';
import { TelegramProvider } from '../providers/telegram.ts';

export function buildProviders(
  state: RelayState,
  credentials: Credentials,
): Map<string, Provider> {
  const providers = new Map<string, Provider>();

  // Stdout is always available (dry-run / smoke tests).
  providers.set('stdout', new StdoutProvider());

  if (credentials.telegram) {
    const tgState = state.getProviderState('telegram');
    providers.set(
      'telegram',
      new TelegramProvider({
        botToken: credentials.telegram.botToken,
        getUpdateIdCursor: () =>
          tgState.telegramUpdateIdCursor as number | undefined,
        setUpdateIdCursor: (n: number) => {
          tgState.telegramUpdateIdCursor = n;
        },
      }),
    );
  }

  // If credentials.telegram is absent, we deliberately do NOT register a
  // telegram provider. Any source declaring `provider: telegram` will fail at
  // add time with a clear "no telegram credentials" message in the runtime —
  // not here.
  return providers;
}
