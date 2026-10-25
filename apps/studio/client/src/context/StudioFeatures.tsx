import { createContext, useContext, useEffect, useState } from 'react';
import { getStudioCapabilities } from '../api/studio-capabilities';

// Deployment features are separate from domain presentation and data schemas.
const StudioFeatures = createContext({ features: [] as string[], error: '', loading: false, retry: () => {} });
export function StudioFeaturesProvider({ children }: { children: React.ReactNode }) {
  const [features, setFeatures] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void getStudioCapabilities(controller.signal)
      .then(value => { if (!controller.signal.aborted) { setFeatures(value); setError(''); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not check optional pages.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  return <StudioFeatures.Provider value={{ features, error, loading, retry: () => setAttempt(value => value + 1) }}>{children}</StudioFeatures.Provider>;
}
export function useStudioFeaturesStatus() { return useContext(StudioFeatures); }
export function useStudioFeature(feature: string): boolean {
  return useContext(StudioFeatures).features.includes(feature);
}
