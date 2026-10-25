export function elapsedTime(start?: number, end?: number): string | undefined {
  if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = Math.floor(end - start);
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
