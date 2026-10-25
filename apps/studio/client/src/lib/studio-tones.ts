import type { StudioTone } from '@openhilo/studio-contracts';

// The renderer owns CSS; applications only choose from stable palette tokens.
export const studioTones: Record<StudioTone, string> = {
  neutral: 'bg-gray-50 text-gray-600', indigo: 'bg-indigo-50 text-indigo-700',
  cyan: 'bg-cyan-50 text-cyan-700', green: 'bg-green-50 text-green-700',
  emerald: 'bg-emerald-50 text-emerald-700', orange: 'bg-orange-50 text-orange-700',
  purple: 'bg-purple-50 text-purple-700', sky: 'bg-sky-50 text-sky-700',
  yellow: 'bg-yellow-50 text-yellow-700',
};
