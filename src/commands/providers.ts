// Shared provider wiring helper. Builds the map of `provider string →
// Provider instance` that both dispatch and runtime consume.
//
// Key invariants:
//  - The map key is the exact `provider` string used in `SourceConfig.provider`
//    (i.e. 'stdout', 'telegram'), which is what dispatch.ts and runtime.ts
//    look up when handling lines and provisioning.
//  - `stdout` is always available — it's the dry-run provider and costs nothing
//    to include.
//  - Telegram is instantiated only when `config.providers.telegram` is present.
//    The update_id cursor is read/written through the state store so the
//    provider stays side-effect-free w.r.t. disk.

import type { RelayConfig } from '../types.ts';
import type { RelayState } from '../state.ts';
import type { Provider } from '../providers/types.ts';
import { StdoutProvider } from '../providers/stdout.ts';
import { TelegramProvider } from '../providers/telegram.ts';

export function buildProviders(
  config: RelayConfig,
  state: RelayState,
): Map<string, Provider> {
  const providers = new Map<string, Provider>();

  // Stdout is always available (dry-run / smoke tests).
  providers.set('stdout', new StdoutProvider());

  if (config.providers.telegram) {
    const tg = config.providers.telegram;
    const tgState = state.getProviderState('telegram');
    providers.set(
      'telegram',
      new TelegramProvider({
        botToken: tg.botToken,
        groups: tg.groups,
        getUpdateIdCursor: () =>
          tgState.telegramUpdateIdCursor as number | undefined,
        setUpdateIdCursor: (n: number) => {
          tgState.telegramUpdateIdCursor = n;
        },
      }),
    );
  }

  return providers;
}
