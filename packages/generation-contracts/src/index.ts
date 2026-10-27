import type { JsonObject, ExecutionHost } from '@openhilo/ai-contracts';
export type { JsonObject } from '@openhilo/ai-contracts';

export interface GlobalStateClass {
  name: string;
  fields: Record<string, string>;
}
export interface GlobalStateIntent {
  name: string;
  inputs: Record<string, { kind: string }>;
  outputs: Record<string, string>;
}
export interface GlobalState {
  classes: GlobalStateClass[];
  intents: GlobalStateIntent[];
}
export interface ClarificationAnswer {
  questionId?: string;
  question: string;
  answer: string;
}
export type WorkflowSourceLayout = 'legacy-files' | 'modules';
export interface GenerationPromptInput {
  /** Actual publication compiler selected by the host, not a model preference. */
  sourceLayout?: WorkflowSourceLayout;
  /** Host catalogue only; contains no credentials or provider identifiers. */
  aiRoutes?: Record<string, {defaultLevel: string; levels: string[]}>;
  naturalLanguage: string;
  round: number;
  maxRounds: number;
  answers?: Record<string, string>;
  /** Ordered turns; repeated question text must not overwrite earlier answers. */
  answerHistory?: ClarificationAnswer[];
  feedback?: string;
  globalState?: GlobalState;
  /** Host-provided runtime ABI; distinct from tools available during generation. */
  systemMethods?: Record<string, { params: string[]; outputs: { name: string; kind: string }[] }>;
}
export interface GenerationPrompt {
  systemPrompt: string;
  userMessage: string;
}
/** Live callbacks stay out of session snapshots; only namespace/version and JSON state persist. */
export interface GenerationPolicy {
  namespace: string;
  version: number;
  /** Optional workspace is isolated scratch space owned by the preparation caller. */
  prepare(naturalLanguage: string, context?: { signal: AbortSignal; workspace?: ExecutionHost['workspace'] }): Promise<JsonObject>;
  restore(state: JsonObject): JsonObject;
  buildPrompt(input: GenerationPromptInput, state: JsonObject): GenerationPrompt;
  describe?(state: JsonObject): JsonObject;
}
export { genericGenerationPolicy, buildGenericPrompt } from './generic-prompt';
