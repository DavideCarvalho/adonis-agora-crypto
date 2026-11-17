import { afterEach } from 'vitest';

// Pages keep their view state in the URL hash (`#/audit?app=billing&result=denied`). The test
// environment keeps one `location` per file, so reset it after each test: a filter left by one test
// must not open the next one filtered. (Node-environment specs have no `window`.)
afterEach(() => {
  if (typeof window !== 'undefined') window.history.replaceState(null, '', '/');
});
