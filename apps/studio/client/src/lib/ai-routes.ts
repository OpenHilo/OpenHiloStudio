import { AI_TYPES, AI_LEVELS, type AiType, type AiLevel } from '@openhilo/itt-contracts/ai-selection';
import { parseAiExecutionConfig, type RoutedExecutionConfig, type DirectAiExecutionConfig } from '@openhilo/studio-contracts/ai-config';
export { AI_TYPES, AI_LEVELS };
export type { AiType, AiLevel, RoutedExecutionConfig, DirectAiExecutionConfig };
export const typeDescriptions: Record<AiType, string> = {
  default: 'Used when a function does not specify an AI type; also used to create workflows.',
  general: 'General tasks and tool-assisted work.', reasoning: 'Analysis, planning, and decisions with multiple constraints.',
  coding: 'Implementing, debugging, and reviewing code.', writing: 'Drafting, editing, and adapting content.',
  search: 'Finding information and synthesizing evidence.',
};
export function routeSummary(cell: DirectAiExecutionConfig): string {
  return cell.adapter === 'codex' ? `${cell.model || 'Codex CLI default'} · ${cell.effort || 'default'} reasoning`
    : `${cell.profiles[cell.default_profile]?.model || 'Missing profile'} · ${cell.adapter}`;
}
export function validateRoutes(routes: RoutedExecutionConfig): string | undefined {
  try { parseAiExecutionConfig(routes); } catch (error) { return (error as Error).message; }
}
export function setRouteCell(config: RoutedExecutionConfig, type: AiType, level: AiLevel, patch: Partial<DirectAiExecutionConfig>): RoutedExecutionConfig {
  const next = structuredClone(config), cell = next.routes[type]?.levels[level];
  if (!cell) throw new Error('Select a configured level.');
  next.routes[type]!.levels[level] = { ...cell, ...patch } as DirectAiExecutionConfig;
  return next;
}
