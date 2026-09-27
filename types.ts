export interface FallbackPluginConfig {
	enabled?: boolean
	retry_on_errors?: number[]
	/** Additional regex patterns (strings) that mark an error as retryable.
	 *  These supplement the built-in patterns. Each string is compiled as
	 *  a case-insensitive regex and matched against the error message. */
	retryable_error_patterns?: string[]
	max_fallback_attempts?: number
	/** Maximum number of times a session may successfully self-heal back to
	 *  its primary model before it stays parked on the fallback leg for the
	 *  rest of the session.  1 = one self-heal attempt (default); 0 = never
	 *  auto-recover (sticky on the fallback leg).  Leaving this unbounded let
	 *  a still-bad primary cost a TTFT timeout + prompt replay every cooldown
	 *  window, indefinitely. */
	max_recovery_probes?: number
	cooldown_seconds?: number
	/** Cooldown for models that failed with a payment/quota/credit error.
	 *  Quota failures do not heal in seconds like transient 429/5xx do, so
	 *  they get a much longer cooldown to prevent oscillation back to the
	 *  quota-exhausted model (each flip re-primes the prompt cache). */
	quota_cooldown_seconds?: number
	/** Time-to-first-token timeout in seconds.  If the fallback model does not
	 *  produce its first token within this window, it is aborted and the next
	 *  fallback is tried.  Once streaming begins the timeout is cancelled.
	 *  Set to 0 to disable. */
	timeout_seconds?: number
	notify_on_fallback?: boolean
	fallback_models?: string | string[]
}

export interface FallbackState {
	originalModel: string
	currentModel: string
	fallbackIndex: number
	failedModels: Map<string, number>
	/** Models that failed with a payment/quota/credit error, mapped to the
	 *  failure timestamp. These use quota_cooldown_seconds instead of
	 *  cooldown_seconds so a quota-exhausted model is not retried after a
	 *  mere 60s. */
	quotaFailures: Map<string, number>
	attemptCount: number
	/** How many times this session has successfully recovered to its primary
	 *  model.  Bounded by config.max_recovery_probes so a persistently bad
	 *  primary cannot be re-probed (with a timeout + prompt replay) forever. */
	recoveryProbes: number
	pendingFallbackModel?: string
}

export interface FallbackResult {
	success: boolean
	newModel?: string
	error?: string
	maxAttemptsReached?: boolean
}

/** Returned by planFallback — describes what to do but does NOT mutate state. */
export interface FallbackPlan {
	success: true
	newModel: string
	failedModel: string
	newFallbackIndex: number
	/** True when the failing error was classified as payment/quota — the
	 *  failed model is recorded in quotaFailures on commit. */
	failedQuota: boolean
}

export interface FallbackPlanFailure {
	success: false
	error: string
	maxAttemptsReached?: boolean
}

export type MessagePart = { type: string } & Record<string, unknown>

export type ReplayTier = 1 | 2 | 3

export interface ReplayResult {
	success: boolean
	tier?: ReplayTier
	sentParts?: MessagePart[]
	droppedTypes?: string[]
	error?: string
}

export interface ChatMessageInput {
	sessionID: string
	agent?: string
	model?: {
		providerID: string
		modelID: string
	}
}

export interface ChatMessageOutput {
	message: {
		model?: {
			providerID: string
			modelID: string
		}
	}
	parts?: Array<{
		type: string
		text?: string
	}>
}

export interface FallbackPluginHook {
	event: (input: {
		event: { type: string; properties?: unknown }
	}) => Promise<void>
	"chat.message"?: (
		input: ChatMessageInput,
		output: ChatMessageOutput
	) => Promise<void>
}

export interface PluginContext {
	directory: string
	client: {
		session: {
			abort: (args: { path: { id: string } }) => Promise<void>
			messages: (args: {
				path: { id: string }
				query: { directory: string }
			}) => Promise<{
				data?: Array<{
					info?: Record<string, unknown>
					parts?: Array<{ type?: string; text?: string }>
				}>
			}>
			promptAsync: (args: {
				path: { id: string }
				body: {
					agent?: string
					/** Reuse an existing user message id so the runtime upserts that
					 *  message instead of minting a new one for each replay. */
					messageID?: string
					model: { providerID: string; modelID: string }
					parts: MessagePart[]
				}
				query: { directory: string }
			}) => Promise<void>
			/** Re-dispatch a command (e.g. compaction) on a specific model.
			 *  Uses the SDK's path/body/query format. */
			command: (args: {
				path: { id: string }
				body: {
					command: string
					arguments: string
					model?: string
					agent?: string
					messageID?: string
				}
				query?: { directory?: string }
			}) => Promise<void>
			/** Revert a specific message, undoing its effects and restoring
			 *  the previous session state.  Used to remove failed compaction
			 *  messages so OpenCode doesn't re-queue them. */
			revert: (args: {
				path: { id: string }
				body: { messageID: string; partID?: string }
				query?: { directory?: string }
			}) => Promise<void>
			/** Re-run compaction/summarization with a specific model.
			 *  This is the actual compaction API — "compact" is not a
			 *  user-facing command. */
			summarize: (args: {
				path: { id: string }
				body: { providerID: string; modelID: string }
				query?: { directory?: string }
			}) => Promise<unknown>
			get: (args: {
				path: { id: string }
			}) => Promise<{ data?: Record<string, unknown> }>
		}
		tui: {
			showToast: (args: {
				body: {
					title: string
					message: string
					variant: string
					duration: number
				}
			}) => Promise<void>
		}
	}
}

export interface HookDeps {
	ctx: PluginContext
	config: Required<FallbackPluginConfig>
	agentConfigs: Record<string, unknown> | undefined
	globalFallbackModels: string[]
	sessionStates: Map<string, FallbackState>
	sessionLastAccess: Map<string, number>
	sessionRetryInFlight: Set<string>
	sessionAwaitingFallbackResult: Set<string>
	sessionFallbackTimeouts: Map<string, ReturnType<typeof setTimeout>>
	sessionFirstTokenReceived: Map<string, boolean>
	/** Timestamp of the last plugin-initiated abort per session.
	 *  Used to distinguish self-inflicted MessageAbortedError from user cancellation. */
	sessionSelfAbortTimestamp: Map<string, number>
	/** Cached parentID for child sessions.  `undefined` value means "looked up,
	 *  no parent" so we distinguish from "never looked up" (key absent). */
	sessionParentID: Map<string, string | null>
	/** Resolvers for code awaiting a session to go idle (e.g. subagent-sync
	 *  waiting for a child session's fallback response to complete). */
	sessionIdleResolvers: Map<string, Array<() => void>>
	/** Timestamp of the last message.updated event per session.
	 *  Used by subagent-sync to detect child activity and reset timeouts. */
	sessionLastMessageTime: Map<string, number>
	/** Sessions with an in-flight compaction fallback via session.command.
	 *  Compaction commands produce no message.updated events, only a final
	 *  session.compacted signal.  While this flag is set, stale errors from
	 *  the pre-compaction model are suppressed and session.idle does not
	 *  treat the silence as a "silent model failure". */
	sessionCompactionInFlight: Set<string>
	/** Child sessions the plugin aborted on a model-fallback path, keyed by
	 *  child session id.  OpenCode's task tool ties its BackgroundJob id to
	 *  the child session id, so aborting the child cancels the parent's task
	 *  job and makes the task tool report "Task cancelled" — even though the
	 *  plugin replays the child on the fallback model and it keeps running.
	 *  The parent's next model request uses this entry to reconcile the
	 *  cancelled task with the child's real result instead of acting on a
	 *  premature cancellation.  `abortedAt` rejects stale pre-abort output;
	 *  `recoveredResult` caches the child's result so later requests reuse it
	 *  without re-polling. */
	sessionRecoveryCandidates: Map<string, { abortedAt: number; recoveredResult?: string }>
}
