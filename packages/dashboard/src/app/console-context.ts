import { createContext, useContext } from 'react';
import type { CryptoApi, Meta } from '../client/crypto-client';

export interface ConsoleState {
  api: CryptoApi;
  meta: Meta;
  partition: string;
  setPartition: (partition: string) => void;
}

export const ConsoleContext = createContext<ConsoleState | null>(null);

export function useConsole(): ConsoleState {
  const state = useContext(ConsoleContext);
  if (!state) throw new Error('the crypto console mounted without its context');
  return state;
}
