export type ScheduleFrequency = 'daily' | 'weekly' | 'advanced';
export function buildScheduleCron(frequency: ScheduleFrequency, time: string, days: number[], raw: string): string {
  if (frequency === 'advanced') {
    if (!raw.trim()) throw new Error('Enter a cron expression.');
    return raw.trim();
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Choose a valid execution time.');
  const [hour, minute] = time.split(':').map(Number);
  if (frequency === 'weekly' && (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) throw new Error('Choose at least one valid weekday.');
  return `${minute} ${hour} * * ${frequency === 'daily' ? '*' : [...new Set(days)].sort().join(',')}`;
}
export function filterScheduleIntents<T extends { name: string; desc: string }>(items: T[], query: string): T[] {
  const term = query.trim().toLocaleLowerCase();
  return items.filter(item => `${item.name} ${item.desc}`.toLocaleLowerCase().includes(term));
}
