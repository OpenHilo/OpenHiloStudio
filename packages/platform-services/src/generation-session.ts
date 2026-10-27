// Provider-neutral generation lifecycle with explicit storage, publication and executor ports.
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import { assertCanStart, validateOutputs, type ExecutionHealth, type AiTaskExecutor, type AiExecution, type ExecutionHost, type TaskRequest, type TaskResult, type SessionRef, type JsonValue, isJsonValue, type JsonObject, type ExtensionState } from '@openhilo/ai-contracts';
import { genericGenerationPolicy, type GenerationPolicy, type ClarificationAnswer, type GlobalState } from '@openhilo/generation-contracts';
import { WorktreeCapacityError } from './worktree-pool';
import { platformSystemMethods } from './compiler-capabilities';
import type { GenerationServices, GenerationQuestionBridge, QuestionOption, PreflightResult, GenerationExecutorContext } from './generation-ports';
export type { GenerationServices, GenerationQuestionBridge, QuestionOption, PreflightResult, GenerationExecutorContext } from './generation-ports';

type PendingQuestion = { id: string; question: string; options?: QuestionOption[]; answerFormat?: 'text' | 'json' };

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionStep = (
  | { phase: 'cc_running';              round: number; maxRounds: number }
  | { phase: 'cc_waiting_for_answer';   questionId: string; question: string; options?: QuestionOption[]; answerFormat?: 'text' | 'json' }
  | { phase: 'auto_fixing';             fixAttempt: number; lastError: string }
  | { phase: 'confirm_merge';           preflight: PreflightResult; entries: string[]; reviewId?: string }
  | { phase: 'done';                    savedPath: string; savedPaths?: string[]; entries?: string[] }
  | { phase: 'error';                   message: string; retryable: boolean; blockingSessionIds?: string[] }) & { revisionRequests?: RevisionRequest[]; aiOutput?: string; aiHealth?: ExecutionHealth; naturalLanguage?: string; answers?: Record<string, string>; answerHistory?: ClarificationAnswer[] };

export interface RevisionRequest { reviewId: string; message: string }
export function validateRevision(input: RevisionRequest, step: SessionStep): void {
  if (typeof input.message !== 'string' || !input.message.trim()) throw Object.assign(new Error('Describe the changes you want.'), {statusCode:400});
  if (step.phase !== 'confirm_merge' || !input.reviewId || input.reviewId !== step.reviewId) throw Object.assign(new Error('This draft has changed or is no longer awaiting review. Refresh the task before sending changes.'), {statusCode:409});
}

export type SessionInput =
  | { type: 'start';        naturalLanguage: string }
  | { type: 'merge_approve'; reviewId?: string }
  | { type: 'merge_reject' }
  | ({ type: 'feedback' } & RevisionRequest)
  | { type: 'retry' }
  | { type: 'mcp_answer';   questionId: string; answer: string };

export interface GenerationConfig {
  /** Compatibility compilation rule, explicitly enabled by the legacy application. */
  legacyEntryTags?: boolean;
  /** Live implementation and host resources are injected, never serialized. */
  generationPolicy?: GenerationPolicy;
  aiExecutor?: AiTaskExecutor;
  aiHost?: (request: TaskRequest) => Partial<ExecutionHost>;
  maxClarificationRounds: number;
  maxFeedbackRounds: number;
  workspace: string;
  sessionDir?: string;
  entityManager?: { queryClasses(): Array<{ name: string }>; queryClassInfo(name: string): { schema?: unknown } };
  dbPath?: string;
  intentsDir?: string;
  questionBridge?: GenerationQuestionBridge;
  /** Live ports are rebound after restoring a snapshot. */
  services?: GenerationServices;
  /** Absolute directory where approved entries are published. */
  publicationDir?: string;
  isHuman?: boolean;
  observationWindow?: boolean;
  defaultOutputDir?: string;
  worktreePath?: string;   // set after pool checkout; path to active ws-pool/ws-XX/
}

export interface SerializedSession {
  revisionRequests?: RevisionRequest[];
  aiHealth?: ExecutionHealth;
  aiOutput?: string;
  id: string;
  config: GenerationConfig;
  phase: SessionStep['phase'];
  round: number;
  feedbackRoundsUsed: number;
  autoFixRound?: number;
  naturalLanguage: string;
  sessionDir: string;
  lastError?: { message: string; retryable: boolean; blockingSessionIds?: string[] };
  savedPath?: string;
  savedPaths?: string[];
  generationPolicyState?: ExtensionState;
  generationPolicyIdentity?: { namespace: string; version: number };
  pendingMcpQuestion?: PendingQuestion;
  answers?: Record<string, string>;
  answerHistory?: ClarificationAnswer[];
  worktreePath?: string;
  archivedWorktreePath?: string;
  pendingPreflight?: PreflightResult;
  pendingEntries?: string[];
  tmuxSessionName?: string; // legacy snapshots only
  aiSession?: SessionRef;
  aiExecutorId?: string;
  lastFixError?: string;
  currentSignalPath?: string;
}

export class InvalidInputError extends Error {
  readonly statusCode = 409;
  constructor(
    message: string,
    public readonly phase: SessionStep['phase'],
    public readonly receivedInput: SessionInput,
  ) {
    super(message);
    this.name = 'InvalidInputError';
    Object.setPrototypeOf(this, InvalidInputError.prototype);
  }
}

// ── GenerationSession ─────────────────────────────────────────────────────────

export class GenerationSession {
  readonly id: string;
  readonly config: GenerationConfig;

  private _phase: SessionStep['phase'] = 'cc_running';
  private _round = 0;
  private _feedbackRoundsUsed = 0;
  private _revisionRequests: RevisionRequest[] = [];
  private _autoFixRound = 0;
  private _naturalLanguage = '';
  private _sessionDir: string;
  private _aiHealth?: ExecutionHealth;
  private _aiOutput = '';
  private _outputSavedAt = 0;
  private _lastError?: { message: string; retryable: boolean; blockingSessionIds?: string[] };
  private _savedPath?: string;
  private _savedPaths?: string[];
  // transient: not serialized — fetched fresh at session start; restored sessions have no globalState (intentional)
  private _globalState?: GlobalState;
  // Persisted policy state keeps generation semantics stable across restore.
  protected _policyState?: ExtensionState;
  private _policyIdentity?: { namespace: string; version: number };
  // transient MCP question state — not serialized
  private _pendingMcpQuestion: PendingQuestion | undefined = undefined;
  /** Translate sessions reject any non-MCP question ingress (see injectNonMcpQuestionForTest). */
  private readonly _strictMcpQuestions = true;
  /** Active translator MCP node id for best-effort cancellation on protocol failure. */
  private _activeMcpNodeId: string | undefined = undefined;
  // Accumulated Q&A from ask_user calls — fed back to buildPrompt on subsequent rounds
  private _mcpAnswers: Record<string, string> = {};
  private _answerHistory: ClarificationAnswer[] = [];
  // Signals the Promise.race() in _raceOrAwait() when a question arrives mid-CC-run
  private _resolveNextQuestion?: (q: PendingQuestion) => void;
  private _cleanup?: Promise<void>;
  private _persistence: Promise<void> = Promise.resolve();
  private _closed = false;
  private _closing?: Promise<void>;
  private readonly _stop = new AbortController();
  private readonly _operations = new Set<Promise<SessionStep>>();
  // The ongoing CC promise while session is in cc_waiting_for_answer
  private _ongoingAiPromise?: Promise<TaskResult>;
  private _aiExecution?: AiExecution;
  private _aiSession?: SessionRef;
  private _aiExecutor?: AiTaskExecutor;
  private _aiExecutorId?: string;
  // Worktree pool state
  private _worktreePath: string | undefined = undefined;
  private _archivedWorktreePath?: string;
  private _pendingPreflight: PreflightResult | undefined = undefined;
  private _pendingEntries: string[] | undefined = undefined;
  // Auto-fix state
  private _tmuxSessionName: string | undefined = undefined;
  private _lastFixError = '';
  private _currentSignalPath: string | undefined = undefined;

  protected constructor(id: string, config: GenerationConfig) {
    this.id = id;
    this.config = config;
    const policy = config.generationPolicy ?? genericGenerationPolicy;
    this._policyIdentity = { namespace: policy.namespace, version: policy.version };
    if (!config.sessionDir || !path.isAbsolute(config.sessionDir)) throw new Error('Generation sessionDir must be an explicit absolute path');
    this._sessionDir = config.sessionDir;
    if (this.config.questionBridge) {
      this.registerIpcHandlers(this.config.questionBridge);
    }
  }

  public bindQuestionBridge(ipcServer: GenerationQuestionBridge): void {
    this.config.questionBridge = ipcServer;
    this.registerIpcHandlers(ipcServer);
  }

  private registerIpcHandlers(ipcServer: GenerationQuestionBridge): void {
    ipcServer.setTranslatorHandlers(
      (id, q, opts) => this.injectQuestion(id, q, opts),
      (id) => this.cancelQuestion(id),
    );
  }

  private registerActiveTranslatorNode(): void {
    if (!this._activeMcpNodeId) return;
    this.config.questionBridge?.setTranslatorHandlersForNode?.(
      this._activeMcpNodeId,
      (id, q, opts) => this.injectQuestion(id, q, opts),
      (id) => this.cancelQuestion(id),
    );
  }

  private clearActiveTranslatorNode(): void {
    if (!this._activeMcpNodeId) return;
    this.config.questionBridge?.clearTranslatorHandlersForNode?.(this._activeMcpNodeId);
  }

  static create(config: GenerationConfig, id = Math.random().toString(36).substring(2, 10)): GenerationSession {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid generation session id');
    return new this(id, config);
  }

  static load(sessionId: string, sessionsRoot: string): GenerationSession {
    if (!path.isAbsolute(sessionsRoot) || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid generation snapshot location');
    const dir = path.join(sessionsRoot, sessionId);
    const raw = fs.readFileSync(path.join(dir, 'session.json'), 'utf-8');
    return this.fromJSON(JSON.parse(raw) as SerializedSession);
  }

  static fromJSON(data: SerializedSession): GenerationSession {
    const s = new this(data.id, { ...data.config, sessionDir: data.sessionDir });
    s._phase = data.phase;
    s._round = data.round;
    s._feedbackRoundsUsed = data.feedbackRoundsUsed;
    s._revisionRequests = data.revisionRequests?.map(item=>({...item})) ?? [];
    s._autoFixRound = data.autoFixRound ?? 0;
    s._naturalLanguage = data.naturalLanguage;
    s._sessionDir = data.sessionDir;
    s._lastError = data.lastError;
    s._aiHealth = data.aiHealth;
    s._aiOutput = typeof data.aiOutput === 'string' ? data.aiOutput.slice(-64_000) : '';
    s._savedPath = data.savedPath;
    s._savedPaths = data.savedPaths;
    if (data.generationPolicyIdentity) s._policyIdentity = { ...data.generationPolicyIdentity };
    else if (data.generationPolicyState) s._policyIdentity = { namespace: data.generationPolicyState.namespace, version: data.generationPolicyState.version };
    s._policyState = data.generationPolicyState ? JSON.parse(JSON.stringify(data.generationPolicyState)) : undefined;
    s._pendingMcpQuestion = data.pendingMcpQuestion;
    s._mcpAnswers = { ...data.answers };
    s._answerHistory = data.answerHistory?.map(turn => ({ ...turn })) ?? Object.entries(s._mcpAnswers).map(([question, answer]) => ({ question, answer }));
    s._worktreePath = data.worktreePath;
    s._archivedWorktreePath = data.archivedWorktreePath;
    s._pendingPreflight = data.pendingPreflight;
    s._pendingEntries = data.pendingEntries;
    s._tmuxSessionName = data.tmuxSessionName;
    s._aiSession = data.aiSession;
    s._aiExecutorId = data.aiExecutorId;
    s._lastFixError = data.lastFixError ?? '';
    s._currentSignalPath = data.currentSignalPath;
    if (s._phase === 'cc_waiting_for_answer' && !s._pendingMcpQuestion) {
      s._phase = 'error';
      s._lastError = {
        message: 'Session restore failed: missing pending MCP question for cc_waiting_for_answer phase; prior effects are unknown',
        retryable: false,
      };
    }
    if (s._phase === 'auto_fixing') {
      // An interrupted attempt may already have effects; do not offer a fresh replay.
      s._phase = 'error';
      s._lastError = {
        message: `Server restarted during auto-fix; prior effects are unknown. Last compiler error:\n${s._lastFixError}`,
        retryable: false,
      };
    }
    return s;
  }

  toJSON(): SerializedSession {
    // Live ports are explicitly rebound by the application after restoration.
    const { questionBridge: _omit, services: _services, aiExecutor: _executor, aiHost: _host, generationPolicy: _policy, entityManager: _entities, ...serializableConfig } = this.config;
    return {
      id: this.id,
      config: serializableConfig as GenerationConfig,
      phase: this._phase,
      round: this._round,
      feedbackRoundsUsed: this._feedbackRoundsUsed,
      revisionRequests: this._revisionRequests.map(item=>({...item})),
      autoFixRound: this._autoFixRound,
      naturalLanguage: this._naturalLanguage,
      sessionDir: this._sessionDir,
      ...(this._aiOutput ? { aiOutput: this._aiOutput } : {}),
      lastError: this._lastError,
      ...(this._aiHealth ? { aiHealth: JSON.parse(JSON.stringify(this._aiHealth)) } : {}),
      savedPath: this._savedPath,
      savedPaths: this._savedPaths,
      generationPolicyIdentity: this._policyIdentity ? { ...this._policyIdentity } : undefined,
      generationPolicyState: this._policyState ? JSON.parse(JSON.stringify(this._policyState)) : undefined,
      pendingMcpQuestion: this._pendingMcpQuestion,
      answers: { ...this._mcpAnswers },
      answerHistory: this._answerHistory.map(turn => ({ ...turn })),
      worktreePath: this._worktreePath,
      archivedWorktreePath: this._archivedWorktreePath,
      pendingPreflight: this._pendingPreflight,
      pendingEntries: this._pendingEntries,
      tmuxSessionName: this._tmuxSessionName,
      aiSession: this._sessionReference(),
      aiExecutorId: this._aiExecutorId ?? this.config.aiExecutor?.id,
      lastFixError: this._lastFixError,
      currentSignalPath: this._currentSignalPath,
    };
  }

  currentStep(): SessionStep {
    const step = this._currentStep();
    // A question can arrive between heartbeat snapshots. Read the live attempt
    // so the question and its health phase agree in the same response.
    const health = this._aiExecution?.health ?? this._aiHealth;
    return { ...step,
      ...(this._revisionRequests.length ? {revisionRequests:this._revisionRequests.map(item=>({...item}))} : {}),
      ...(this._aiOutput ? { aiOutput: this._aiOutput } : {}),
      ...(this._naturalLanguage ? { naturalLanguage: this._naturalLanguage } : {}),
      ...(this._answerHistory.length ? { answerHistory: this._answerHistory.map(turn => ({ ...turn })) } : {}),
      ...(Object.keys(this._mcpAnswers).length ? { answers: { ...this._mcpAnswers } } : {}),
      ...(health ? { aiHealth: JSON.parse(JSON.stringify(health)) } : {}),
    };
  }

  private _currentStep(): SessionStep {
    switch (this._phase) {
      case 'cc_running':
        return { phase: 'cc_running', round: this._round, maxRounds: this.config.maxClarificationRounds };
      case 'cc_waiting_for_answer':
        if (!this._pendingMcpQuestion) {
          return {
            phase: 'error',
            message: 'Session is waiting for MCP answer but question state is missing',
            retryable: true,
          };
        }
        return {
          phase: 'cc_waiting_for_answer',
          questionId: this._pendingMcpQuestion.id,
          question: this._pendingMcpQuestion.question,
          options: this._pendingMcpQuestion.options,
          ...(this._pendingMcpQuestion.answerFormat ? { answerFormat: this._pendingMcpQuestion.answerFormat } : {}),
        };
      case 'auto_fixing':
        return { phase: 'auto_fixing', fixAttempt: this._autoFixRound, lastError: this._lastFixError };
      case 'confirm_merge':
        return {
          phase: 'confirm_merge',
          preflight: this._pendingPreflight!,
          entries: this._pendingEntries ?? [],
          reviewId: this._reviewId(),
        };
      case 'done':
        return {
          phase: 'done',
          savedPath: this._savedPath ?? '',
          ...(this._savedPaths ? { savedPaths: this._savedPaths } : {}),
          ...(this._savedPaths?.length ? {entries:[...(this._pendingEntries ?? [])]} : {}),
        };
      case 'error':
        return { phase: 'error', message: this._lastError?.message ?? '', retryable: this._lastError?.retryable ?? false,
          ...(this._lastError?.blockingSessionIds ? { blockingSessionIds: [...this._lastError.blockingSessionIds] } : {}) };
    }
  }

  async respond(input: SessionInput): Promise<SessionStep> {
    if (this._closed) throw new Error('Generation session is closed');
    const operation = (async () => {
      const step = await this._respond(input);
      await this._cleanup;
      await this.flushPersistence();
      return step;
    })();
    this._operations.add(operation);
    try { return await operation; } finally { this._operations.delete(operation); }
  }

  /** Stop live work without publishing or recycling an unapproved candidate. */
  close(reason = 'Generation host is shutting down'): Promise<void> {
    if (this._closing) return this._closing;
    this._closed = true;
    const hadWork = this._round > 0 || this._naturalLanguage !== '' || this._operations.size > 0;
    const active = this._operations.size > 0 || ['cc_running', 'cc_waiting_for_answer', 'auto_fixing'].includes(this._phase);
    this._stop.abort(reason);
    this._closing = (async () => {
      let failure: unknown;
      try { await this._aiExecution?.cancel(reason); }
      catch (error) { failure = error; }
      await Promise.allSettled([...this._operations]);
      await this._cleanup;
      if (active && this._phase !== 'done' && this._phase !== 'confirm_merge') {
        this._pendingMcpQuestion = undefined;
        this._ongoingAiPromise = undefined;
        this._lastError = { message: reason === 'Generation host is shutting down' ? 'Generation execution stopped during host shutdown; inspect the workspace before starting new work' : `${reason}; inspect the workspace before starting new work`, retryable: false };
        this._phase = 'error';
      }
      this.clearActiveTranslatorNode();
      this._activeMcpNodeId = undefined;
      // Reading an unbound snapshot must never construct a provider just to close it.
      if (this._aiExecutor || this.config.aiExecutor) {
        try { await this._releaseAiSession(); } catch (error) { failure ??= error; }
      }
      if (hadWork) await this._persist();
      await this.flushPersistence();
      if (failure) throw failure;
    })();
    return this._closing;
  }

  private async _respond(input: SessionInput): Promise<SessionStep> {
    if (this._worktreePath) this._services().assertWorktreeOwner(this._worktreePath, this.id);
    // mcp_answer is phase-driven and bypasses the round guard
    if (input.type === 'mcp_answer') {
      if (this._phase === 'error') return this.currentStep();
      if (input.questionId !== this._pendingMcpQuestion?.id) {
        throw new InvalidInputError('This question is no longer current. Your answer was not applied. Refresh the task to see its current question or result.', this._phase, input);
      }
      this._assertValidInput(input);
      return this._handleMcpAnswer(input);
    }

    // Initial call: only 'start' is valid before the session has begun
    if (this._round === 0) {
      if (input.type !== 'start') {
        throw new InvalidInputError(
          `First respond() call must be { type: 'start' }`,
          this._phase,
          input,
        );
      }
      return this._handleStart((input as { type: 'start'; naturalLanguage: string }).naturalLanguage);
    }

    // Terminal error check
    if (this._phase === 'error' && this._lastError && !this._lastError.retryable) {
      if (input.type !== 'retry') {
        throw new InvalidInputError(`Session is in terminal error state`, 'error', input);
      }
      throw new InvalidInputError(`Error is not retryable`, 'error', input);
    }

    // Validate input for current phase
    this._assertValidInput(input);

    switch (input.type) {
      case 'feedback': {
        validateRevision(input,this.currentStep());
        this._revisionRequests.push({reviewId:input.reviewId,message:input.message.trim()});
        this._feedbackRoundsUsed++;
        this._pendingPreflight=undefined;
        this._autoFixRound=0;
        this._aiOutput='';
        this._aiHealth=undefined;
        this._setPhase('cc_running');
        await this.flushPersistence();
        return this._runAi({feedback:this._revisionFeedback(),continueConversation:true});
      }
      case 'merge_approve':
        if (!input.reviewId || input.reviewId !== this._reviewId()) {
          throw new InvalidInputError('This approval does not match the current review. Nothing was published. Refresh the task and review the current candidate before approving.', this._phase, input);
        }
        return this._handleMergeApprove();
      case 'merge_reject':
        return this._handleMergeReject();
      case 'retry':
        return this._handleRetry();
      default:
        // 'start' is handled above via the _round === 0 guard; unreachable here
        throw new InvalidInputError(
          `Input type '${(input as SessionInput).type}' is not valid at this point`,
          this._phase,
          input,
        );
    }
  }

  // ── MCP question injection ─────────────────────────────────────────────────

  /**
   * Test-only stand-in for forbidden stdout/manual question paths.
   * In strict MCP mode, always transitions to terminal protocol error.
   */
  injectNonMcpQuestionForTest(_questionId: string, _question: string): void {
    if (!this._strictMcpQuestions) return;
    void this.protocolViolation(
      'Protocol violation: non-MCP question path is forbidden; questions must use MCP ask_user only.',
    );
  }

  injectQuestion(questionId: string, question: string, options?: QuestionOption[], answerFormat?: 'text' | 'json'): void {
    if (this._closed) return;
    const q: PendingQuestion = { id: questionId, question, options, ...(answerFormat === 'json' ? { answerFormat } : {}) };
    const optErr = this._questionOptionsError(options);

    if (optErr) {
      // When CC is racing on ask_user, we must resolve the race so _raceOrAwait can fail-closed.
      if (this._resolveNextQuestion) {
        const resolve = this._resolveNextQuestion;
        this._resolveNextQuestion = undefined;
        resolve(q);
        return;
      }
      void this.protocolViolation(optErr);
      return;
    }

    this._pendingMcpQuestion = q;
    this._setPhase('cc_waiting_for_answer');
    // Signal the Promise.race() in _raceOrAwait() so respond() returns early
    this._resolveNextQuestion?.(q);
    this._resolveNextQuestion = undefined;
  }

  cancelQuestion(questionId: string): void {
    if (this._pendingMcpQuestion?.id !== questionId) return;
    this._pendingMcpQuestion = undefined;
    this._ongoingAiPromise = undefined;
    this.clearActiveTranslatorNode();
    this._activeMcpNodeId = undefined;
    this._lastError = { message: 'CC exited while waiting for question answer', retryable: false };
    this._setPhase('error');
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _questionOptionsError(options?: QuestionOption[]): string | undefined {
    if (!options?.length) return undefined;
    const recommended = options.filter((o) => o.recommended);
    if (recommended.length > 1) {
      return 'Invalid MCP question options: at most one recommended choice is allowed';
    }
    for (const o of options) {
      if (o.recommended && !String(o.reason ?? '').trim()) {
        return 'Invalid MCP question options: recommended choice requires a non-empty reason';
      }
    }
    return undefined;
  }

  private protocolViolation(message: string): SessionStep {
    if (this._activeMcpNodeId) {
      this.config.questionBridge?.cancelNodeQuestions(this._activeMcpNodeId);
    }
    this.clearActiveTranslatorNode();
    this._resolveNextQuestion = undefined;
    this._pendingMcpQuestion = undefined;
    this._ongoingAiPromise = undefined;
    this._activeMcpNodeId = undefined;
    this._lastError = { message, retryable: false };
    return this._setPhase('error');
  }

  private _assertValidInput(input: SessionInput): void {
    const phase = this._phase;
    const valid: Record<SessionStep['phase'], SessionInput['type'][]> = {
      cc_running:              [],
      cc_waiting_for_answer:   ['mcp_answer'],
      auto_fixing:             ['mcp_answer'],
      confirm_merge:           ['merge_approve', 'merge_reject', 'feedback'],
      done:                    [],
      error:                   ['retry'],
    };
    const allowedTypes = valid[phase] ?? [];
    if (!allowedTypes.includes(input.type)) {
      throw new InvalidInputError(
        input.type === 'merge_approve' || input.type === 'merge_reject'
          ? 'This task is no longer waiting for review. Nothing was changed. Refresh the task to see its current result.'
          : `Input type '${input.type}' is not valid for phase '${phase}'`,
        phase,
        input,
      );
    }
  }

  private _fetchGlobalState(): GlobalState | undefined {
    const { entityManager, intentsDir } = this.config;
    if (!entityManager) return undefined;

    // Classes and their field schemas
    const classRows = entityManager.queryClasses();
    const classes = classRows.map(({ name }) => {
      const info = entityManager.queryClassInfo(name);
      const raw = typeof info.schema === 'object' && info.schema !== null ? info.schema : {};
      const schema = Object.entries(raw).reduce((acc, [k, v]) => {
        if (typeof v === 'string') acc[k] = v;
        return acc;
      }, {} as Record<string, string>);
      return { name, fields: schema };
    });

    // Intents from intentsDir
    const intents: GlobalState['intents'] = [];
    if (intentsDir && fs.existsSync(intentsDir)) {
      for (const file of fs.readdirSync(intentsDir)) {
        if (!file.endsWith('.itt.json') || file.endsWith('.itt.impl.json')) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(intentsDir, file), 'utf-8')) as {
            name?: string;
            inputs?: Record<string, { kind: string }>;
            outputs?: Record<string, string>;
          };
          if (raw.name) {
            intents.push({
              name: raw.name,
              inputs: raw.inputs ?? {},
              outputs: raw.outputs ?? {},
            });
          }
        } catch { /* skip malformed files */ }
      }
    }

    return { classes, intents };
  }

  private async _handleStart(nl: string): Promise<SessionStep> {
    this._naturalLanguage = nl;
    let policyWorkspace: string | undefined;
    try {
      const policy = this._getGenerationPolicy();
      const globalState = await this._fetchGlobalState();
      // Classification must never write into the primary brain before review.
      // This temporary workspace is not copied into the generation candidate.
      fs.mkdirSync(this._sessionDir, { recursive: true });
      policyWorkspace = fs.mkdtempSync(path.join(this._sessionDir, 'policy-'));
      const data = await policy.prepare(nl, { signal: this._stop.signal,
        workspace: { id: policyWorkspace, uri: pathToFileURL(policyWorkspace).href } });
      this._globalState = globalState;
      this._validatePolicyData(data);
      this._policyState = { namespace: policy.namespace, version: policy.version, data: JSON.parse(JSON.stringify(data)) };
    } catch (err) {
      this._lastError = { message: `Generation policy preparation failed: ${(err as Error).message}`, retryable: false };
      return this._setPhase('error');
    } finally {
      if (policyWorkspace) fs.rmSync(policyWorkspace, { recursive: true, force: true });
    }

    if (this._closed) throw new Error('Generation session is closed');
    // Checkout a worktree for this session
    try {
      this._worktreePath = this._services().checkoutWorktree(this.id);
      this.config.worktreePath = this._worktreePath;
    } catch (err) {
      this._lastError = { message: (err as Error).message, retryable: false,
        ...(err instanceof WorktreeCapacityError ? { blockingSessionIds: [...err.blockingSessionIds] } : {}) };
      return this._setPhase('error');
    }

    return this._runAi();
  }

  private async _emitPolicyLog(round: number): Promise<void> {
    if (!this._policyState) return;
    const policy = this._getGenerationPolicy();
    const detail = policy.describe?.(JSON.parse(JSON.stringify(this._policyState.data)));
    if (!detail) return;
    this._validatePolicyData(detail);

    const record = {
      ts: new Date().toISOString(),
      sessionId: this.id,
      round,
      policy: this._policyState.namespace,
      version: this._policyState.version,
      ...detail,
      naturalLanguagePreview: this._naturalLanguage.slice(0, 160),
    };

    console.log(`[generation_policy] ${JSON.stringify(record)}`);
    try {
      const roundDir = path.join(this._sessionDir, `round-${round}`);
      await fs.promises.mkdir(roundDir, { recursive: true });
      await fs.promises.appendFile(
        path.join(roundDir, 'prompt-profile.log'),
        `${JSON.stringify(record)}\n`,
        'utf-8',
      );
    } catch (err) {
      console.warn(`[generation_policy] failed to write prompt-profile.log: ${(err as Error).message}`);
    }
  }

  private async _handleRetry(): Promise<SessionStep> {
    if (!this._lastError?.retryable) {
      throw new InvalidInputError(`Error is not retryable`, 'error', { type: 'retry' });
    }
    await this._aiExecution?.cancel('User requested a new generation attempt');
    await this._releaseAiSession();
    // Reset auto-fix counter so the user gets 3 fresh attempts after retry
    this._autoFixRound = 0;
    this._currentSignalPath = undefined;
    return this._runAi();
  }

  private async _autoFix(compileErrors: string): Promise<SessionStep> {
    const MAX_FIX_ATTEMPTS = 3;
    if (this._autoFixRound >= MAX_FIX_ATTEMPTS) {
      this._lastError = {
        message: `Auto-fix failed after ${MAX_FIX_ATTEMPTS} attempts. Last compiler error:\n${compileErrors}`,
        retryable: true,
      };
      return this._setPhase('error');
    }

    this._autoFixRound += 1;
    const attempt = this._autoFixRound;
    const worktreePath = this._worktreePath ?? this._sessionDir;
    this._lastFixError = compileErrors;
    this._phase = 'auto_fixing';
    await this._persist();
    const changedFileContents: Record<string, string> = { ...this._pendingPreflight?.contents };
    for (const relPath of this._pendingPreflight?.modified ?? []) {
      const absPath = path.join(worktreePath, relPath);
      if (fs.existsSync(absPath)) changedFileContents[relPath] = fs.readFileSync(absPath, 'utf8');
    }
    try {
      const generationPrompt = this._buildGenerationPrompt();
      const prompt = {
        systemPrompt: generationPrompt.systemPrompt + '\n\nFix compiler diagnostics in the generated workflow source files. Use the task question interface if clarification is needed.',
        userMessage: `${generationPrompt.userMessage}\n\nCompiler diagnostics:\n${compileErrors}\n\nCandidate source files:\n${JSON.stringify(changedFileContents)}\n\nFix these files, then return the entries JSON using the publication compiler entry format specified above.`,
      };
      return await this._raceOrAwait(this._startAiTask(prompt, path.join(this._sessionDir, `fix-${attempt}`, 'prompt.md'), true));
    } catch (err) {
      this._lastError = { message: (err as Error).message, retryable: true };
      return this._setPhase('error');
    }
  }

  private _revisionFeedback(): string | undefined {
    return this._revisionRequests.length ? 'Continue adjusting the existing draft in this workspace. Preserve prior requirements unless the user changes them. Return the complete updated entry list.\n\nUser change requests, oldest first:\n'+this._revisionRequests.map((item,index)=>`${index+1}. ${item.message}`).join('\n\n') : undefined;
  }

  private async _runAi(overrides?: { feedback?: string; signalFileName?: string; continueConversation?: boolean }): Promise<SessionStep> {
    if (!this._policyState) {
      this._lastError = { message: 'Generation policy state not set — run start first', retryable: false };
      return this._setPhase('error');
    }

    try {
      this._round += 1;
      await this._emitPolicyLog(this._round);
      const roundDir = path.join(this._sessionDir, `round-${this._round}`);
      await fs.promises.mkdir(roundDir, { recursive: true });

      const promptPath = path.join(roundDir, 'prompt.md');

      const prompt = this._buildGenerationPrompt(overrides?.feedback ?? this._revisionFeedback());

      this._phase = 'cc_running';
      await this._persist();

      return await this._raceOrAwait(this._startAiTask(prompt, promptPath, Boolean(overrides?.continueConversation)));
    } catch (err) {
      this._lastError = { message: (err as Error).message, retryable: true };
      return this._setPhase('error');
    }
  }

  private _buildGenerationPrompt(feedback?: string) {
    if (!this._policyState) throw new Error('Generation policy state is missing');
    const policy = this._getGenerationPolicy();
    this._validatePolicyData(this._policyState.data);
    const restoredState = policy.restore(JSON.parse(JSON.stringify(this._policyState.data)));
    this._validatePolicyData(restoredState);
    this._policyState = { ...this._policyState, data: JSON.parse(JSON.stringify(restoredState)) };
    return policy.buildPrompt({
      sourceLayout: this.config.services?.sourceLayout ?? 'legacy-files',
      naturalLanguage: this._naturalLanguage,
      round: this._round,
      maxRounds: this.config.maxClarificationRounds,
      feedback,
      globalState: this._globalState ? JSON.parse(JSON.stringify(this._globalState)) : undefined,
      systemMethods: JSON.parse(JSON.stringify(platformSystemMethods)),
      answerHistory: this._answerHistory.map(turn => ({ ...turn })),
      answers: Object.keys(this._mcpAnswers).length > 0 ? { ...this._mcpAnswers } : undefined,
    }, JSON.parse(JSON.stringify(restoredState)));

  }

  /** Pass a validated copy to compiler adapters; they cannot rewrite saved policy state. */
  private _preflightOptions() {
    const legacyEntryTags = this.config.legacyEntryTags ?? false;
    if (!this._policyState) return { legacyEntryTags };
    const policy = this._getGenerationPolicy();
    this._validatePolicyData(this._policyState.data);
    const data = policy.restore(JSON.parse(JSON.stringify(this._policyState.data)));
    this._validatePolicyData(data);
    return { legacyEntryTags, generationPolicyState: { ...this._policyState, data: JSON.parse(JSON.stringify(data)) as JsonObject } };
  }

  public bindGenerationPolicy(policy: GenerationPolicy): void {
    const identities = [this._policyState, this._policyIdentity].filter(Boolean);
    if (identities.some(identity => identity!.namespace !== policy.namespace || identity!.version !== policy.version)) {
      throw new Error('Generation policy identity/version does not match the saved session');
    }
    this.config.generationPolicy = policy;
    this._policyIdentity = { namespace: policy.namespace, version: policy.version };
  }

  private _validatePolicyData(data: unknown): asserts data is JsonObject {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !isJsonValue(data)) {
      throw new Error('Generation policy state must be a JSON object');
    }
  }

  private _getGenerationPolicy(): GenerationPolicy {
    const policy = this.config.generationPolicy ?? genericGenerationPolicy;
    if (!policy.namespace?.trim() || !Number.isSafeInteger(policy.version) || policy.version < 1) throw new Error('Invalid generation policy identity');
    if (this._policyState && this._policyIdentity &&
        (this._policyState.namespace !== this._policyIdentity.namespace || this._policyState.version !== this._policyIdentity.version)) {
      throw new Error('Saved generation policy identity conflicts with its state');
    }
    const identity = this._policyState ?? this._policyIdentity;
    if (identity && (policy.namespace !== identity.namespace || policy.version !== identity.version)) {
      throw new Error(`Generation policy ${identity.namespace}@${identity.version} must be rebound; no policy was substituted`);
    }
    return policy;
  }

  public bindAiExecutor(executor: AiTaskExecutor, host?: GenerationConfig['aiHost']): void {
    if (this._aiExecutorId && this._aiExecutorId !== executor.id) throw new Error('Generation executor identity does not match the saved session');
    this.config.aiExecutor = executor;
    this.config.aiHost = host;
    this._aiExecutor = executor;
  }

  public bindServices(services: GenerationServices): void { this.config.services = services; }

  private _services(): GenerationServices {
    if (!this.config.services) throw new Error('Generation services must be rebound before continuing this session');
    return this.config.services;
  }

  /** Compatibility compositions may restore a provider; the standalone service has no default provider. */
  protected async createExecutor(context: GenerationExecutorContext): Promise<{ executor: AiTaskExecutor; session?: SessionRef }> {
    throw new Error(`Generation executor ${context.savedExecutorId ?? '(unspecified)'} must be rebound; no provider was substituted`);
  }

  protected async readLegacyResult(_workspace: string, _signalPath?: string): Promise<string[] | undefined> {
    throw new Error('The saved generation attempt has no recoverable session reference; it was not replayed.');
  }

  private async _getAiExecutor(): Promise<AiTaskExecutor> {
    if (this._aiExecutor) return this._aiExecutor;
    if (this.config.aiExecutor) this._aiExecutor = this.config.aiExecutor;
    else {
      const restored = await this.createExecutor({ savedExecutorId: this._aiExecutorId,
        legacySession: this._tmuxSessionName, workspace: this._worktreePath ?? this._sessionDir });
      this._aiExecutor = restored.executor;
      if (!this._aiSession) this._aiSession = restored.session;
    }
    if (this._aiExecutorId && this._aiExecutorId !== this._aiExecutor.id) {
      this._aiExecutor = undefined;
      throw new Error('Generation executor identity does not match the saved session');
    }
    this._aiExecutorId = this._aiExecutor.id;
    return this._aiExecutor;
  }

  private _executionHost(request: TaskRequest): ExecutionHost {
    const workspace = path.resolve(this._worktreePath ?? this._sessionDir);
    const extra = this.config.aiHost?.(request);
    return { attemptId: crypto.randomUUID(), runId: this.id,
      ...extra,
      signal: extra?.signal ? AbortSignal.any([this._stop.signal, extra.signal]) : this._stop.signal,
      workspace: { id: workspace, uri: pathToFileURL(workspace).href },
      onEvent: event => {
        if (event.type === 'health') {
          this._aiHealth = JSON.parse(JSON.stringify(event.health));
          void this._persist();
        } else if (event.type === 'terminal') { this._aiHealth = undefined; void this._persist(); }
        try { extra?.onEvent?.(structuredClone(event)); } catch { /* observers do not drive session state */ }
        if (this._closed) return;
        if (event.type === 'question') this.injectQuestion(event.question.id, event.question.prompt, event.question.options, event.question.answer);
        if (['progress','tool_started','tool_finished'].includes(event.type)) {
          const message = event.type === 'progress' ? event.message : event.type === 'tool_started' ? `\n[Tool started: ${event.tool}]\n` : event.type === 'tool_finished' ? `\n[Tool ${event.outcome}: ${event.tool}]\n` : '';
          this._aiOutput = (this._aiOutput + message).slice(-64_000);
          if (Date.now() - this._outputSavedAt > 500) { this._outputSavedAt = Date.now(); void this._persist(); }
        }
      },
    };
  }

  private async _startAiTask(prompt: { systemPrompt: string; userMessage: string }, promptPath: string, repair: boolean): Promise<TaskResult> {
    await fs.promises.mkdir(path.dirname(promptPath), { recursive: true });
    await fs.promises.writeFile(promptPath, `# System Prompt\n\n${prompt.systemPrompt}\n\n# User Message\n\n${prompt.userMessage}`);
    if (this._closed) throw new Error('Generation session is closed');
    const executor = await this._getAiExecutor();
    if (this._closed) throw new Error('Generation session is closed');
    const request: TaskRequest = { version: 1, taskId: crypto.randomUUID(), instruction: prompt.userMessage,
      ...(this._policyState ? { context: [JSON.parse(JSON.stringify(this._policyState))] } : {}),
      role: prompt.systemPrompt, inputs: {}, output: { entries: 'json' }, requiredCapabilities: ['workspace', 'questions'],
      ...(repair && this._aiSession && executor.capabilities.includes('continue') ? { continuation: this._aiSession } : {}),
    };
    this._aiHealth = undefined;
    const host = this._executionHost(request);
    assertCanStart(request, host, executor.id, executor.capabilities);
    this._aiExecution = await executor.start(request, host);
    if (this._closed) await this._aiExecution.cancel('Generation host is shutting down');
    // A continuation cursor is not the recoverable identity of the newly accepted attempt.
    this._aiSession = this._aiExecution.session;
    void this._persist();
    const result = await this._acceptedAiResult(this._aiExecution);
    if (result.session) this._aiSession = result.session;
    return result;
  }

  private async _acceptedAiResult(execution: AiExecution): Promise<TaskResult> {
    try { return await execution.result; }
    catch (error) {
      return { status: 'failed', error: { code: 'outcome_unknown',
        message: error instanceof Error ? error.message : String(error),
        retryable: false, safeToReplay: false } };
    }
  }

  private _sessionReference(): SessionRef | undefined {
    if (this._aiExecution && (this._aiExecution.state === 'running' || this._aiExecution.state === 'waiting_for_input' || this._aiExecution.state === 'stopping')) {
      return this._aiExecution.session;
    }
    return this._aiSession ?? this._aiExecution?.session;
  }

  private async _releaseAiSession(): Promise<void> {
    if (!this._aiExecution?.session && !this._aiSession && !this._tmuxSessionName) return;
    const executor = await this._getAiExecutor();
    const session = this._sessionReference();
    if (session) await executor.releaseSession?.(session);
    this._aiExecution = undefined;
    this._aiSession = undefined;
    this._tmuxSessionName = undefined;
  }

  /** Race CC completion against an incoming ask_user question. When a question
   *  arrives, returns cc_waiting_for_answer immediately (CC stays alive).
   *  When CC completes (or after an answer is provided), processes the result. */
  private async _raceOrAwait(
    ccPromise: Promise<TaskResult>,
  ): Promise<SessionStep> {

    const questionRace = new Promise<PendingQuestion>(
      (resolve) => { this._resolveNextQuestion = resolve; if (this._pendingMcpQuestion) resolve(this._pendingMcpQuestion); },
    );

    const winner = await Promise.race([
      ccPromise.then(r  => ({ kind: 'done' as const,     result: r })),
      questionRace.then(q => ({ kind: 'question' as const, ...q })),
    ]);

    if (winner.kind === 'question') {
      const optErr = this._questionOptionsError(winner.options);
      if (optErr) {
        return this.protocolViolation(optErr);
      }
      // CC is still running, blocked inside ask_user — surface the question
      this._ongoingAiPromise = ccPromise;
      this._pendingMcpQuestion = { id: winner.id, question: winner.question, options: winner.options, ...(winner.answerFormat ? { answerFormat: winner.answerFormat } : {}) };
      // A backend can fail while the UI is waiting; do not leave a dead question visible.
      void ccPromise.then(result => {
        if (this._ongoingAiPromise === ccPromise && this._phase === 'cc_waiting_for_answer' && result.status !== 'completed') {
          this._pendingMcpQuestion = undefined;
          this._ongoingAiPromise = undefined;
          void this._processAiResult(result);
        }
      }, error => {
        if (this._ongoingAiPromise === ccPromise && this._phase === 'cc_waiting_for_answer') {
          this._pendingMcpQuestion = undefined;
          this._ongoingAiPromise = undefined;
          this._lastError = { message: error instanceof Error ? error.message : String(error), retryable: false };
          this._setPhase('error');
        }
      });
      return this._setPhase('cc_waiting_for_answer');
    }

    // CC completed before any question
    this._resolveNextQuestion = undefined;
    this._ongoingAiPromise = undefined;
    this._activeMcpNodeId = undefined;
    return this._processAiResult(winner.result);
  }

  private async _processAiResult(result: TaskResult): Promise<SessionStep> {
    try { return await this._processConfirmedAiResult(result); }
    catch (error) {
      // Validation/preflight follow accepted work. A fresh generation attempt
      // cannot safely repair an unknown outcome of those checks.
      this._lastError = { message: error instanceof Error ? error.message : String(error), retryable: false };
      return this._setPhase('error');
    }
  }

  private async _processConfirmedAiResult(result: TaskResult): Promise<SessionStep> {
    if (this._closed) {
      this._lastError = { message: 'Generation execution stopped during host shutdown', retryable: false };
      this._phase = 'error';
      return this.currentStep();
    }
    this.clearActiveTranslatorNode();
    this._activeMcpNodeId = undefined;
    if (result.session) this._aiSession = result.session;
    if (result.status === 'completed') {
      const output = validateOutputs({ entries: 'json' }, result.outputs);
      if (!Array.isArray(output.entries) || !output.entries.every(entry => typeof entry === 'string' && entry.trim())) {
        this._lastError = { message: 'Generation result entries must be non-empty strings', retryable: false };
        return this._setPhase('error');
      }
      // Run pre-flight checks
      const worktreePath = this._worktreePath ?? this._sessionDir;
      const preflight = await this._services().runPreflight(worktreePath, output.entries as string[], this._preflightOptions());
      if (!preflight.ok) {
        // Store failed preflight so _autoFix can read file contents for the fix prompt
        this._pendingPreflight = preflight;
        if (preflight.requiresTargetSync) {
          this._lastError = { message: preflight.compileErrors ?? 'Synchronize the candidate with the current publication target before continuing.', retryable: false };
          return this._setPhase('error');
        }
        return this._autoFix(preflight.compileErrors ?? 'TypeScript compile failed');
      }
      if (preflight.deleted.length > 0) {
        this._lastError = {
          message: `Session attempted to delete files: ${preflight.deleted.join(', ')}. Deletions are not allowed from the translator.`,
          retryable: false,
        };
        return this._setPhase('error');
      }
      // Preflight passed — reset fix counter
      this._autoFixRound = 0;
      this._pendingPreflight = preflight;
      this._pendingEntries = output.entries as string[];
      return this._setPhase('confirm_merge');
    }
    this._lastError = result.status === 'failed' ? { message: result.error.message, retryable: result.error.retryable && result.error.safeToReplay } : { message: `Generation cancelled: ${result.reason}`, retryable: false };
    return this._setPhase('error');
  }

  private async _handleMcpAnswer(input: { questionId: string; answer: string }): Promise<SessionStep> {
    if (input.questionId !== this._pendingMcpQuestion?.id) {
      throw new InvalidInputError('This question is no longer current. Your answer was not applied. Refresh the task to see its current question or result.',
        this._phase, { type: 'mcp_answer', ...input });
    }
    const question = this._pendingMcpQuestion;
    if (!this._aiExecution && this._aiSession) {
      try {
        const executor = await this._getAiExecutor();
        if (!executor.reconnect || !executor.capabilities.includes('reconnect')) throw new Error('The generation attempt is no longer attached; this executor cannot reconnect. It was not replayed.');
        const request: TaskRequest = { version: 1, taskId: crypto.randomUUID(), instruction: 'Reconnect generation', inputs: {}, output: { entries: 'json' }, requiredCapabilities: ['workspace'] };
        this._aiExecution = await executor.reconnect(this._aiSession, this._executionHost(request));
        this._ongoingAiPromise = this._acceptedAiResult(this._aiExecution);
      } catch (error) {
        this._lastError = { message: error instanceof Error ? error.message : String(error), retryable: false };
        return this._setPhase('error', true);
      }
    }
    if (this._aiExecution) {
      const value: JsonValue = question?.answerFormat === 'json' ? JSON.parse(input.answer) : input.answer;
      const receipt = await this._aiExecution.answer(input.questionId, value);
      if (receipt !== 'accepted' && receipt !== 'duplicate') {
        throw new InvalidInputError('Your answer was not accepted because this question is no longer available. Refresh the task to see its current status.',
          this._phase, { type: 'mcp_answer', ...input });
      }
    } else this.config.questionBridge?.resolveQuestion(input.questionId, input.answer);
    this._mcpAnswers[question!.question] = input.answer;
    this._answerHistory.push({ questionId: input.questionId, question: question!.question, answer: input.answer });
    // answer() can synchronously resume the provider and deliver its next question.
    // Clear only the answered question, never a newly delivered one.
    if (this._pendingMcpQuestion?.id === input.questionId) this._pendingMcpQuestion = undefined;
    // Answers can be accepted long before the next model response. Reads must
    // expose a running phase rather than a waiting phase without a question.
    this._aiHealth = this._aiExecution?.health ? structuredClone(this._aiExecution.health) : undefined;
    this._setPhase(this._pendingMcpQuestion ? 'cc_waiting_for_answer' : this._autoFixRound > 0 ? 'auto_fixing' : 'cc_running');

    const ongoing = this._ongoingAiPromise;
    this._ongoingAiPromise = undefined;
    if (!ongoing) {
      // Pre-contract snapshot compatibility is confined to the legacy adapter.
      if (!this._aiExecutorId && !this.config.aiExecutor) {
        try {
          const entries = await this.readLegacyResult(this._worktreePath ?? this._sessionDir, this._currentSignalPath);
          if (entries !== undefined) return this._processAiResult({ status: 'completed', outputs: { entries }, artifacts: [] });
        } catch (error) {
          this._lastError = { message: error instanceof Error ? error.message : String(error), retryable: false };
          return this._setPhase('error', true);
        }
      }
      if (this._aiExecutorId || this.config.aiExecutor) {
        this._lastError = { message: 'The saved generation attempt has no recoverable session reference; it was not replayed.', retryable: false };
        return this._setPhase('error', true);
      }
      // Pre-contract snapshots without durable output retain their old behavior.
      this.clearActiveTranslatorNode();
      this._activeMcpNodeId = undefined;
      this._setPhase('cc_running');
      return this.currentStep();
    }

    // Race again: CC may ask another question or complete
    try {
      return await this._raceOrAwait(ongoing);
    } catch (err) {
      this._lastError = { message: (err as Error).message, retryable: false };
      return this._setPhase('error', true);
    }
  }

  private _reviewId(): string {
    return crypto.createHash('sha256').update(JSON.stringify({ sessionId: this.id,
      ...(this._revisionRequests.length ? {revisionRequests:this._revisionRequests} : {}),
      preflight: this._pendingPreflight, entries: this._pendingEntries ?? [] })).digest('hex');
  }

  private async _handleMergeApprove(): Promise<SessionStep> {
    const publicationDir = this.config.publicationDir;
    if (!publicationDir || !path.isAbsolute(publicationDir)) throw new Error('Generation publicationDir must be an explicit absolute path');
    const worktreePath = this._worktreePath ?? this._sessionDir;
    // A failed publication must retain its candidate and workspace for inspection.
    // In particular, never recycle a workspace in a finally block after failure.
    try {
      await this._services().executeMerge(worktreePath, this._pendingPreflight!, this._pendingEntries ?? []);
    } catch (error) {
      if (error instanceof Error && /review again|current publication receipt/.test(error.message)) {
        const refreshed = await this._services().runPreflight(worktreePath, this._pendingEntries ?? [], this._preflightOptions());
        if (refreshed.ok) {
          this._pendingPreflight = refreshed;
          // Approval of the old receipt never approves this replacement.
          return this._setPhase('confirm_merge');
        }
        throw new InvalidInputError(refreshed.compileErrors ?? error.message, this._phase,
          { type: 'merge_approve', reviewId: this._reviewId() });
      }
      throw error;
    }
    this._savedPath = publicationDir;
    this._savedPaths = (this._pendingEntries ?? []).map(e => path.join(publicationDir, e));
    await this._releaseAiSession();
    if (this._worktreePath) {
      this._archivedWorktreePath = this._services().returnWorktree(this._worktreePath, this.id);
      this.config.worktreePath = undefined;
      this._worktreePath = undefined;
    }
    return this._setPhase('done');
  }

  private async _handleMergeReject(): Promise<SessionStep> {
    await this._releaseAiSession();
    if (this._worktreePath) {
      this._archivedWorktreePath = this._services().returnWorktree(this._worktreePath, this.id);
      this.config.worktreePath = undefined;
      this._worktreePath = undefined;
    }
    this._savedPath = '';
    this._savedPaths = [];
    return this._setPhase('done');
  }

  private _setPhase(phase: SessionStep['phase'], retainUnconfirmedAttempt = false): SessionStep {
    // A failed reconnect cannot prove remote cleanup: retain its identity and lease.
    // Stop/release the implementation before recycling its workspace.
    if (!retainUnconfirmedAttempt && !this._closed && phase === 'error' && this._lastError && !this._lastError.retryable) {
      const worktree = this._worktreePath;
      this._cleanup = (async () => {
        await this._aiExecution?.cancel('Generation session failed');
        await this._releaseAiSession();
        if (worktree) {
          this._archivedWorktreePath = this._services().returnWorktree(worktree, this.id);
          this.config.worktreePath = undefined;
          if (this._worktreePath === worktree) this._worktreePath = undefined;
        }
        await this._persist();
      })().catch(error => {
        // Preserve the lease on cleanup failure, preventing reuse while effects are unknown.
        this._lastError = { message: `${this._lastError?.message ?? 'Generation failed'}; cleanup failed: ${String(error)}`, retryable: false };
      });
    }
    this._phase = phase;
    void this._persist(); // fire-and-forget persistence
    return this.currentStep();
  }

  /** Wait for already queued snapshot writes, useful before shutdown or workspace cleanup. */
  async flushPersistence(): Promise<void> { await this._persistence; }

  private _persist(): Promise<void> {
    // Serialize writes and atomically replace snapshots so an older question/state cannot
    // overwrite a newer terminal result or leave partially written JSON after a crash.
    const snapshot = JSON.stringify(this.toJSON(), null, 2);
    this._persistence = this._persistence.then(async () => {
      await fs.promises.mkdir(this._sessionDir, { recursive: true });
      const temp = path.join(this._sessionDir, `.session-${crypto.randomUUID()}.json`);
      try {
        await fs.promises.writeFile(temp, snapshot);
        await fs.promises.rename(temp, path.join(this._sessionDir, 'session.json'));
      } finally { await fs.promises.unlink(temp).catch(() => {}); }
    }).catch(() => { /* Persistence remains best effort; API callers also save snapshots. */ });
    return this._persistence;
  }
}
