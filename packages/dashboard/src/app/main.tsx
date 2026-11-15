import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../agora-kit/fonts';
import { ThemeProvider } from '../agora-kit/theme';
import { App, CRYPTO_ACCENT } from './App';
import './index.css';

/**
 * Refetch every 15s: a rotation, a policy change or an operation by another process should show up
 * without a reload. Actions invalidate their lists explicitly.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 15_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider storageKey="agora-crypto-theme" accent={CRYPTO_ACCENT}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
