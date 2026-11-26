import { createContext, useContext } from 'react';
import type { CryptoApi, FederatedAppInfo, Meta } from '../client/crypto-client';

export interface ConsoleState {
  api: CryptoApi;
  meta: Meta;
  partition: string;
  setPartition: (partition: string) => void;
  /** The picked app when it is another app (the federated console). */
  federated?: FederatedAppInfo | undefined;
  /** Why key operations are unavailable for the picked app, or undefined when they are. */
  readOnly?: string | undefined;
  /**
   * Why creating, rotating, re-policying or deleting keys is unavailable (the picked app is
   * read-only, or the viewer's console grant lacks `crypto:keys:manage`), or undefined when it is.
   */
  cannotManage?: string | undefined;
}

export const ConsoleContext = createContext<ConsoleState | null>(null);

export function useConsole(): ConsoleState {
  const state = useContext(ConsoleContext);
  if (!state) throw new Error('the crypto console mounted without its context');
  return state;
}
