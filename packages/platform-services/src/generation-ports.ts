import type { PublicationCandidate } from './publication';
import type { ExtensionState } from '@openhilo/ai-contracts';

/** Opaque application context; only an explicitly selected compiler interprets it. */
export interface GenerationPreflightOptions {
  legacyEntryTags?: boolean;
  generationPolicyState?: ExtensionState;
}

export interface QuestionOption { label: string; value: string; recommended?: boolean; reason?: string }
type QuestionHandler = (id: string, question: string, options?: QuestionOption[]) => void;
/** Optional bridge for externally hosted questions. AI contract events need no bridge. */
export interface GenerationQuestionBridge {
  setTranslatorHandlers(question: QuestionHandler, cancel: (id: string) => void): void;
  setTranslatorHandlersForNode?(nodeId: string, question: QuestionHandler, cancel: (id: string) => void): void;
  clearTranslatorHandlersForNode?(nodeId: string): void;
  cancelNodeQuestions(nodeId: string): void;
  resolveQuestion(questionId: string, answer: string): unknown;
}
export interface PreflightResult {
  ok: boolean;
  compileErrors?: string;
  /** Git ancestry must be synchronized; asking AI to repair source cannot fix this. */
  requiresTargetSync?: boolean;
  added: string[];
  modified: string[];
  deleted: string[];
  diffs: Record<string, string>;
  contents: Record<string, string>;
  /** Missing in legacy snapshots; requires a fresh review before publication. */
  candidate?: PublicationCandidate;
}
/** Synchronous lease ownership checks precede async AI and publication work. */
export interface GenerationServices {
  /** Omission preserves compatibility with older file-layout hosts. */
  sourceLayout?: import('@openhilo/generation-contracts').WorkflowSourceLayout;
  checkoutWorktree(sessionId: string): string;
  assertWorktreeOwner(worktreePath: string, sessionId: string): void;
  returnWorktree(worktreePath: string, sessionId: string): string;
  runPreflight(worktreePath: string, entries: string[], options: GenerationPreflightOptions & { legacyEntryTags: boolean }): Promise<PreflightResult>;
  executeMerge(worktreePath: string, preflight: PreflightResult, entries: string[]): Promise<void>;
}
export interface GenerationExecutorContext { savedExecutorId?: string; legacySession?: string; workspace: string }
