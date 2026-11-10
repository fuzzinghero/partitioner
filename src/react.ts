import { useEffect, useState, useSyncExternalStore } from 'react';
import { createAnalyzer } from './client.js';
import type { AnalyzerOptions } from './client.js';

/** Optional React adapter. All processing and worker state live in the framework-free client. */
export function useAnalyzer(options?: AnalyzerOptions) {
  // Options are construction-time configuration. Creating the client starts no worker or file read.
  const [client] = useState(() => createAnalyzer(options));
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => {
    const clearOnNavigation = () => client.cancel();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) client.cancel();
    };
    window.addEventListener('pagehide', clearOnNavigation);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', clearOnNavigation);
      window.removeEventListener('pageshow', onPageShow);
      // cancel releases every resource and allows React StrictMode's effect setup/cleanup cycle.
      client.cancel();
    };
  }, [client]);
  return {
    ...snapshot,
    analyze: client.analyze,
    getPartitions: client.getPartitions,
    getContexts: client.getContexts,
    getMembers: client.getMembers,
    getEntry: client.getEntry,
    getRequestChanges: client.getRequestChanges,
    compare: client.compare,
    start: client.start,
    importFile: client.importFile,
    loadSample: client.loadSample,
    cancel: client.cancel,
    request: client.request,
  };
}
export type { AnalyzerOptions, AnalyzerSnapshot } from './client.js';

/** @deprecated Use useAnalyzer. */
export const useHarAnalyzer = useAnalyzer;
