import type { HookDeps, MessagePart, FallbackPlan } from "./types"
import { logInfo, logError } from "./logger"
import { getFallbackModelsForSession, resolveAgentForSession } from "./config-reader"
import { prepareFallback, planFallback, commitFallback, createFallbackState } from "./fallback-state"
import { replayWithDegradation } from "./message-replay"

const SESSION_TTL_MS = 30 * 60 * 1000
/** How long a fallback-aborted child stays eligible for cancelled-task
 *  recovery before its candidate is dropped.  Bounds the cache when the
 *  parent never issues another request. */
const RECOVERY_CANDIDATE_TTL_MS = 10 * 60 * 1000

declare function setTimeout(
	callback: () => void | Promise<void>,
	delay?: number
): ReturnType<typeof globalThis.setTimeout>
declare function clearTimeout(timeout: ReturnType<typeof globalThis.setTimeout>): void

// Delay after abort to let OpenCode's session-level abort propagation settle.
// Without this, a promptAsync sent immediately after abort can itself be aborted
// because OpenCode's abort is session-wide and takes time to fully propagate.
const POST_ABORT_DELAY_MS = 150

/** The compaction agent's configured model, when it has one.
 *
 *  The runtime resolves the compaction model as `agent.compaction.model ??
 *  userMessage.model` (packages/opencode/src/session/compaction.ts), and no
 *  plugin hook can change it afterwards (the agent map is built once per
 *  instance; `config.update` does not rebuild it). So when the agent pins a
 *  model, every `session.summarize` re-dispatch we make runs on that same pin
 *  no matter which model we pass — retrying only re-runs a failing model in a
 *  loop. Callers use this to stop instead of looping. */
function compactionModelPin(agentConfigs: Record<string, unknown> | undefined): string | undefined {
	const compaction = agentConfigs?.compaction as { model?: unknown } | undefined
	const model = compaction?.model
	return typeof model === "string" && model.length > 0 ? model : undefined
}

function summarizeParts(parts: MessagePart[] | undefined): {
	count: number
	types: string[]
	textChars: number
	hasToolCall: boolean
} {
	if (!parts || parts.length === 0) {
		return { count: 0, types: [], textChars: 0, hasToolCall: false }
	}

	const typeSet = new Set<string>()
	let textChars = 0
	let hasToolCall = false

	for (const part of parts) {
		typeSet.add(part.type)
		const textValue = (part as Record<string, unknown>).text
		if (part.type === "text" && typeof textValue === "string") {
			textChars += textValue.length
		}
		if (part.type === "tool_call") {
			hasToolCall = true
		}
	}

	return {
		count: parts.length,
		types: Array.from(typeSet),
		textChars,
		hasToolCall,
	}
}

type RawSessionMessage = {
	info?: Record<string, unknown>
	parts?: any[]
}

/** A replayable prompt selected from a session's message history. */
interface ReplaySelection {
	parts: MessagePart[]
	source: "last-user" | "last-non-assistant"
	/** The id of the replayed user message, when the selection was a user
	 *  message.  Reused as promptAsync's messageID so the runtime upserts the
	 *  turn instead of minting a duplicate (commit 01e6b33). */
	messageID?: string
}

/**
 * Pick the message to replay from a session's message history.
 *
 * Prefer the last user message.  In child subagent sessions the latest
 * replayable prompt can be non-user (e.g. system/tool), so fall back to the
 * last non-assistant message with parts.  Skip messages that only contain
 * "compaction" parts — those are internal to OpenCode's compaction and cannot
 * be replayed via promptAsync.
 *
 * Returns undefined when nothing is replayable.
 */
function selectReplayableMessage(
	msgs: RawSessionMessage[] | undefined
): ReplaySelection | undefined {
	let lastUserPartsRaw: any[] | undefined
	let lastNonAssistantPartsRaw: any[] | undefined
	let lastUserMessageID: string | undefined

	for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
		const m = msgs?.[i]
		const role = ((m?.info?.role ?? (m as any)?.role ?? "") as string).toLowerCase()
		const parts = m?.parts ?? (m?.info?.parts as any[] | undefined)
		if (!parts || parts.length === 0) continue

		// Skip compaction-only messages: parts where every part is
		// type "compaction" (not replayable via promptAsync).
		const hasOnlyCompactionParts = parts.every((p: any) => p.type === "compaction")
		if (hasOnlyCompactionParts) continue

		if (!lastNonAssistantPartsRaw && role !== "assistant") {
			lastNonAssistantPartsRaw = parts
		}

		if (role === "user") {
			lastUserPartsRaw = parts
			const messageID = (m?.info?.id ?? (m as any)?.id) as unknown
			lastUserMessageID =
				typeof messageID === "string" && messageID.length > 0 ? messageID : undefined
			break
		}
	}

	const replayPartsRaw = lastUserPartsRaw ?? lastNonAssistantPartsRaw
	if (!replayPartsRaw || replayPartsRaw.length === 0) return undefined

	// Filter out "compaction" type parts — internal to OpenCode's compaction
	// and not replayable via promptAsync.
	const parts: MessagePart[] = replayPartsRaw.filter(
		(p: any): p is MessagePart => typeof p.type === "string" && p.type !== "compaction"
	)
	if (parts.length === 0) return undefined

	return {
		parts,
		source: lastUserPartsRaw ? "last-user" : "last-non-assistant",
		messageID: lastUserPartsRaw ? lastUserMessageID : undefined,
	}
}

export function createAutoRetryHelpers(deps: HookDeps) {
	const {
		ctx,
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
		sessionFallbackTimeouts,
	} = deps

	/** Look up the parentID for a session, with caching.
	 *  Returns the parentID string if this is a child session, or null. */
	const getParentSessionID = async (sessionID: string): Promise<string | null> => {
		const cached = deps.sessionParentID.get(sessionID)
		if (cached !== undefined) return cached

		try {
			const sessionInfo = await ctx.client.session.get({ path: { id: sessionID } })
			const sessionData = (sessionInfo?.data ?? sessionInfo) as Record<string, unknown>
			const parentID = typeof sessionData?.parentID === "string" && sessionData.parentID.length > 0
				? sessionData.parentID
				: null
			deps.sessionParentID.set(sessionID, parentID)
			if (parentID) {
				logInfo("Detected child session", { sessionID, parentID })
			}
			return parentID
		} catch {
			logError("Failed to look up parentID", { sessionID })
			return null
		}
	}

	const abortSessionRequest = async (sessionID: string, source: string): Promise<void> => {
		// Aborting a child session tears down the parent's task BackgroundJob
		// (they share an id), so the parent's task tool reports "Task
		// cancelled" while the plugin's fallback replay keeps the child alive.
		// Record the child *before* the abort so the parent's next model
		// request can be reconciled with the child's real result.  A user stop
		// and our own duplicate-replay abort are genuine cancellations and must
		// not be recovered.
		const recordRecovery =
			source !== "session.stop" && !source.startsWith("duplicate-replay")
		try {
			if (recordRecovery) {
				const parentID = await getParentSessionID(sessionID)
				if (parentID) {
					deps.sessionRecoveryCandidates.set(sessionID, { abortedAt: Date.now() })
					logInfo("Recorded child session for cancelled-task recovery", {
						sessionID,
						parentID,
						source,
					})
				}
			}

			await ctx.client.session.abort({ path: { id: sessionID } })
			deps.sessionSelfAbortTimestamp.set(sessionID, Date.now())
			logInfo(`Aborted in-flight session request (${source})`, { sessionID })
		} catch (error) {
			logError(`Failed to abort in-flight session request (${source})`, {
				sessionID,
				error: String(error),
			})
		}
	}

	const clearSessionFallbackTimeout = (sessionID: string) => {
		const timer = sessionFallbackTimeouts.get(sessionID)
		if (timer) {
			clearTimeout(timer)
			sessionFallbackTimeouts.delete(sessionID)
		}
	}

	const scheduleSessionFallbackTimeout = (
		sessionID: string,
		resolvedAgent?: string,
		timeoutMsOverride?: number
	) => {
		clearSessionFallbackTimeout(sessionID)

		// An override of 0 means "advance the chain now" — used when the current
		// model is known to be too slow for this request (see localProviders).
		const fromConfig = timeoutMsOverride === undefined
		if (fromConfig && config.timeout_seconds <= 0) return
		const timeoutMs = fromConfig ? config.timeout_seconds * 1000 : Math.max(0, timeoutMsOverride)
		// When this timer was armed.  Guard 3 below uses it to tell a child
		// subagent that is still streaming (activity since arming) from one
		// that went quiet before the parent did.
		const armedAt = Date.now()

		const timer = setTimeout(async () => {
			sessionFallbackTimeouts.delete(sessionID)

			// TTFT: if first token has been received, model is streaming — don't abort
			if (deps.sessionFirstTokenReceived.get(sessionID)) {
				logInfo("Timeout fired but first token already received, skipping abort", {
					sessionID,
				})
				return
			}

			const state = sessionStates.get(sessionID)
			if (!state) return

			// If another handler (e.g. session.idle silent-failure or
			// session.status) already holds the retry lock, it is already
			// advancing the fallback chain.  Don't interfere.
			if (sessionRetryInFlight.has(sessionID)) {
				logInfo("Timeout fired but retry already in flight, deferring", { sessionID })
				return
			}

			// ── STAND-DOWN GUARDS ──
			// The TTFT timer must only abort a session that is genuinely
			// waiting on a model's first token.  Three states look like
			// silence but are not a stalled model, and aborting in them
			// destroys live work: session.abort cascades into child
			// sessions, so the abort kills a running subagent mid-command
			// ("User aborted the command") with no recovery (observed
			// 2026-09-28T13:49:17Z: a stale timer on an idle orchestrator
			// cancelled ses_f17be46b7ffeZ8nhBPqY7fCee1 mid-pytest).
			//
			// Fetch the messages once; the fetch is shared with the replay
			// selection below.  A failed fetch must not abort — the same
			// fail-safe as an un-replayable message applies.
			let sessionMessages: RawSessionMessage[] | undefined
			try {
				const messagesResp = await ctx.client.session.messages({
					path: { id: sessionID },
					query: { directory: ctx.directory },
				})
				sessionMessages = messagesResp.data ?? []
			} catch (error) {
				logError("Failed to inspect session messages before timeout abort", {
					sessionID,
					error: String(error),
				})
				scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
				return
			}

			// Guard 1 — tool execution in flight: the last assistant message
			// still carries a running/pending tool part (a long bash command
			// or a foreground task subagent).  The loop is inside tool
			// execution, so no model request is in flight; the timer was
			// armed by the tool part's own message.updated.
			const lastAssistant = [...sessionMessages]
				.reverse()
				.find(
					(m) =>
						((m?.info?.role ?? (m as any)?.role ?? "") as string).toLowerCase() ===
						"assistant",
				)
			const assistantParts = (lastAssistant?.parts ??
				(lastAssistant?.info?.parts as any[] | undefined) ??
				[]) as Array<Record<string, any>>
			const runningTool = assistantParts.find(
				(p) =>
					p?.type === "tool" &&
					(p?.state?.status === "running" || p?.state?.status === "pending"),
			)
			if (runningTool) {
				logInfo(
					"Timeout fired while a tool call is still running; standing down instead of aborting",
					{ sessionID, tool: runningTool.tool },
				)
				scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
				return
			}

			// Guard 2 — idle session: the turn already completed (e.g. it
			// ended by dispatching a background task subagent) and a
			// trailing message.updated raced session.idle's cleanup to
			// re-arm this timer.  An idle session has no request to abort.
			try {
				const sessionResp = await ctx.client.session.get({ path: { id: sessionID } })
				const sessionData = (sessionResp?.data ?? sessionResp) as
					| Record<string, unknown>
					| undefined
				const rawStatus = sessionData?.status
				const statusType =
					typeof rawStatus === "string"
						? rawStatus
						: ((rawStatus as Record<string, unknown> | undefined)?.type as
								| string
								| undefined)
				if (statusType === "idle") {
					logInfo(
						"Timeout fired while the session is idle (no model request in flight); standing down instead of aborting",
						{ sessionID },
					)
					scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
					return
				}
			} catch (error) {
				logError("Failed to read session status before timeout abort", {
					sessionID,
					error: String(error),
				})
				scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
				return
			}

			// Guard 3 — active child session: a background task subagent is
			// still producing messages (activity since this timer was
			// armed).  Aborting the parent cancels the child mid-command, so
			// stand down while the child works; the re-armed timer retries
			// once the child goes quiet.
			for (const [childSessionID, parentID] of deps.sessionParentID.entries()) {
				if (parentID !== sessionID) continue
				const lastActivity = deps.sessionLastMessageTime.get(childSessionID)
				if (lastActivity !== undefined && lastActivity >= armedAt) {
					logInfo(
						"Timeout fired while a child subagent session is still active; standing down instead of aborting",
						{
							sessionID,
							childSessionID,
							msSinceChildActivity: Date.now() - lastActivity,
						},
					)
					scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
					return
				}
			}

			// Determine the replayable message BEFORE aborting.  Aborting a
			// request that we cannot replay kills the turn silently — no
			// recovery, no user-visible answer — which is worse than a slow
			// request.  Compaction fallbacks are exempt: they re-run via
			// session.summarize (not a prompt replay) and still need the abort.
			const fallbackModels = getFallbackModelsForSession(
				sessionID,
				resolvedAgent,
				deps.agentConfigs,
				deps.globalFallbackModels
			)

			let preparedReplay: ReplaySelection | undefined
			if (fallbackModels.length > 0 && resolvedAgent !== "compaction") {
				preparedReplay = selectReplayableMessage(sessionMessages)

				if (!preparedReplay) {
					logInfo(
						"No replayable message; leaving the in-flight request running instead of aborting",
						{ sessionID, currentModel: state.currentModel }
					)
					// Re-arm the timeout instead of falling back: the request
					// can still complete on its own, and a later timeout can
					// try again once a replayable message exists.
					scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
					return
				}
			}

			// For TTFT timeouts we MUST abort even for child sessions — the
			// hung model is still consuming the session and we cannot send a
			// replay until it is stopped.  The downstream autoRetryWithFallback
			// will handle the child-session concern (skipping its own abort
			// since we already did it here).
			//
			// Clear compaction-in-flight: the compaction timed out, so the
			// next attempt needs a clean slate (the new autoRetryWithFallback
			// call will re-set the flag if it dispatches compaction again).
			deps.sessionCompactionInFlight.delete(sessionID)
			await abortSessionRequest(sessionID, "session.timeout")

			if (state.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}

			if (fallbackModels.length === 0) return

			logInfo("Session fallback timeout reached", {
				sessionID,
				timeoutSeconds: config.timeout_seconds,
				currentModel: state.currentModel,
			})

			// Timeout callback manages its own lock lifecycle
			sessionRetryInFlight.add(sessionID)
			try {
				const plan = planFallback(sessionID, state, fallbackModels, config)
				if (plan.success) {
					await autoRetryWithFallback(
						sessionID,
						plan.newModel,
						resolvedAgent,
						"session.timeout",
						plan,
						preparedReplay
					)
				}
			} finally {
				sessionRetryInFlight.delete(sessionID)
			}
		}, timeoutMs)

		sessionFallbackTimeouts.set(sessionID, timer)
	}

	const autoRetryWithFallback = async (
		sessionID: string,
		newModel: string,
		resolvedAgent: string | undefined,
		source: string,
		plan?: FallbackPlan,
		preparedReplay?: ReplaySelection
	): Promise<boolean> => {
		// Track whether we skipped because another handler owns the dispatch.
		// In that case, the finally block must NOT clear sessionAwaitingFallbackResult.
		let deferredToOtherHandler = false

		// Guard: if the state has already been advanced past this model by
		// a concurrent handler (race between message.updated / session.error /
		// session.status), skip this retry — the other handler owns it now.
		// When using plan-based flow, state hasn't been committed yet, so
		// check against the failed model (which should still be current).
		const preCheckState = sessionStates.get(sessionID)
		if (plan) {
			if (preCheckState && preCheckState.currentModel !== plan.failedModel) {
				logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, expected failed model ${plan.failedModel}`, {
					sessionID,
					staleModel: newModel,
					currentModel: preCheckState.currentModel,
				})
				deferredToOtherHandler = true
				return false
			}
		} else if (preCheckState && preCheckState.currentModel !== newModel) {
			logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${preCheckState.currentModel}, wanted ${newModel}`, {
				sessionID,
				staleModel: newModel,
				currentModel: preCheckState.currentModel,
			})
			deferredToOtherHandler = true
			return false
		}

		const modelParts = newModel.split("/")
		if (modelParts.length < 2) {
			logInfo(`Invalid model format (missing provider prefix): ${newModel}`)
			const state = sessionStates.get(sessionID)
			if (state?.pendingFallbackModel) {
				state.pendingFallbackModel = undefined
			}
			return false
		}

		const fallbackModelObj = {
			providerID: modelParts[0],
			modelID: modelParts.slice(1).join("/"),
		}

		// ── TOP-LEVEL SESSION HANDLING ──
		// Decide whether to abort based on model state, not session type.
		//
		// Error-triggered sources (session.error, message.updated): the model
		// has already stopped — abort is unnecessary and harmful (for child
		// sessions it signals the parent that the child is done, causing an
		// empty response).
		//
		// Timeout (session.timeout): the caller already aborted because the
		// model was hung — just wait for propagation.
		//
		// Status sources (session.status, session.status.immediate): the model
		// is still in a provider retry loop — abort is needed to stop it.
		const modelAlreadyStopped = source === "session.error" || source === "message.updated"
		const callerAlreadyAborted = source === "session.timeout"
		// session.idle.silent-failure: the model went idle without producing
		// tokens.  No NEW abort is needed, but a recent abort (e.g. from
		// session.timeout or session.status) may still be propagating.
		// We must wait for propagation before sending the replay.
		const mayHaveRecentAbort = source === "session.idle.silent-failure"

		if (modelAlreadyStopped) {
			logInfo(`Skipping abort — model already stopped (${source})`, {
				sessionID,
				newModel,
			})
		} else if (callerAlreadyAborted || mayHaveRecentAbort) {
			const selfAbortTs = deps.sessionSelfAbortTimestamp.get(sessionID)
			const msSinceAbort = selfAbortTs ? Date.now() - selfAbortTs : undefined
			if (selfAbortTs && msSinceAbort !== undefined && msSinceAbort < POST_ABORT_DELAY_MS * 2) {
				logInfo(`Waiting for recent abort propagation (${source})`, {
					sessionID,
					msSinceAbort,
				})
				// Wait the remaining time until the abort propagation window closes
				const remainingMs = Math.max(0, POST_ABORT_DELAY_MS - msSinceAbort)
				if (remainingMs > 0) {
					await new Promise<void>((resolve) =>
						setTimeout(() => resolve(), remainingMs)
					)
				}
			} else if (callerAlreadyAborted) {
				logInfo(`Caller already aborted (${source}), waiting for propagation`, {
					sessionID,
				})
				await new Promise<void>((resolve) =>
					setTimeout(() => resolve(), POST_ABORT_DELAY_MS)
				)
			}
		} else {
			await abortSessionRequest(sessionID, `pre-fallback.${source}`)
			await new Promise<void>((resolve) =>
				setTimeout(() => resolve(), POST_ABORT_DELAY_MS)
			)
		}

		// Note: The caller holds sessionRetryInFlight. We do NOT manage it here.
		deps.sessionFirstTokenReceived.set(sessionID, false)
		let retryDispatched = false
		try {
			// ── COMPACTION FALLBACK: ABORT + SUMMARIZE ON FALLBACK MODEL ──
			// OpenCode's session.summarize endpoint:
			//  1. Calls SessionRevert.cleanup (undoes any revert state)
			//  2. Creates a NEW compaction via SessionCompaction.create with
			//     the model we specify (providerID + modelID)
			//  3. Runs SessionPrompt.loop to process it
			//
			// Key insight: summarize handles cleanup internally, so we don't
			// need to revert or delete messages ourselves.  We just need to
			// abort the stuck session and wait for it to settle, then call
			// summarize with the fallback model.
			if (resolvedAgent === "compaction") {
				// A pinned compaction model cannot be switched by a summarize
				// re-dispatch, so retrying would loop on the same failing model
				// (observed 2026-09-25: 31s compaction → luna → abort → luna).
				// Stop here; the runtime retries compaction on its own cadence.
				const pinnedCompaction = compactionModelPin(deps.agentConfigs)
				if (pinnedCompaction) {
					logInfo("Compaction is pinned to a fixed model; failover cannot switch it — skipping re-dispatch", {
						sessionID,
						pinned: pinnedCompaction,
						failedModel: plan?.failedModel,
						newModel,
						source,
					})
					return false
				}

				const failedModel = plan?.failedModel
				logInfo(`Compaction fallback: abort + summarize on fallback (${source})`, {
					sessionID,
					failedModel,
					newModel,
				})

				// Suppress stale errors from the failed compaction
				deps.sessionCompactionInFlight.add(sessionID)

				if (failedModel && plan) {
					const currentState = sessionStates.get(sessionID)
					if (currentState) {
						if (!currentState.failedModels.has(failedModel)) {
							currentState.failedModels.set(failedModel, Date.now())
						}
					}
				}

				// Step 1: Abort the stuck session
				try {
					await abortSessionRequest(sessionID, "compaction-fallback")
				} catch {
					logError(`Failed to abort session for compaction fallback (${source})`, { sessionID })
				}

				// Step 2: Wait for abort to fully propagate.
				await new Promise<void>((resolve) => setTimeout(resolve, 500))

				// Step 3: Delete the failed compaction messages from the session.
				// session.summarize calls SessionPrompt.loop which processes
				// messages in order — if the old failed compaction messages remain,
				// the loop retries them on k2p5 instead of using our new model.
				// The DELETE /session/{id}/message/{messageID} endpoint removes
				// them permanently (not available as a typed SDK method, so we
				// use the SDK's internal HTTP client directly).
				try {
					const messagesResp = await ctx.client.session.messages({
						path: { id: sessionID },
						query: { directory: ctx.directory },
					})
					const msgs = messagesResp.data ?? []

					// Collect message IDs to delete: failed assistant + compaction user
					// Delete in reverse order (newest first) to avoid index shifts
					const deleteIDs: string[] = []
					for (let i = msgs.length - 1; i >= 0; i--) {
						const msg = msgs[i]
						const msgRole = msg.info?.role as string | undefined
						const msgError = msg.info?.error
						const msgID = msg.info?.id as string | undefined
						const parts = msg.parts ?? []
						const isCompactionMsg = parts.length > 0 &&
							parts.every((p: any) => p.type === "compaction")

						if (!msgID) continue

						// Failed assistant message
						if (msgRole === "assistant" && msgError) {
							deleteIDs.push(msgID)
							continue
						}

						// Compaction user message
						if (isCompactionMsg) {
							deleteIDs.push(msgID)
							break // stop after finding both
						}
					}

					// Use the SDK's internal client to make raw DELETE calls
					const rawClient = (ctx.client.session as any)?._client
					if (rawClient && deleteIDs.length > 0) {
						for (const msgID of deleteIDs) {
							logInfo(`Deleting compaction message (${source})`, {
								sessionID,
								messageID: msgID,
							})
							try {
								await rawClient.delete({
									url: "/session/{id}/message/{messageID}",
									path: { id: sessionID, messageID: msgID },
								})
								logInfo(`Deleted compaction message (${source})`, {
									sessionID,
									messageID: msgID,
								})
							} catch (delErr) {
								logError(`Failed to delete compaction message (${source})`, {
									sessionID,
									messageID: msgID,
									error: String(delErr),
								})
							}
						}
					} else if (deleteIDs.length > 0) {
						logError(`Cannot access raw SDK client for message deletion (${source})`, {
							sessionID,
							messageCount: deleteIDs.length,
						})
					}
				} catch (msgErr) {
					logError(`Failed during compaction message cleanup (${source})`, {
						sessionID,
						error: String(msgErr),
					})
				}

				// Small delay to let deletions settle
				await new Promise<void>((resolve) => setTimeout(resolve, 200))

				// Step 4: Call session.summarize with the fallback model
				try {
					if (sessionAwaitingFallbackResult.has(sessionID)) {
						logInfo(`Skipping duplicate compaction summarize (${source})`, { sessionID })
						deferredToOtherHandler = true
						return false
					}
					sessionAwaitingFallbackResult.add(sessionID)

					logInfo(`Dispatching session.summarize on fallback model (${source})`, {
						sessionID,
						providerID: fallbackModelObj.providerID,
						modelID: fallbackModelObj.modelID,
					})

					const summarizeResult = await ctx.client.session.summarize({
						path: { id: sessionID },
						body: {
							providerID: fallbackModelObj.providerID,
							modelID: fallbackModelObj.modelID,
						},
						query: { directory: ctx.directory },
					})

					logInfo(`session.summarize response (${source})`, {
						sessionID,
						model: newModel,
						response: (JSON.stringify(summarizeResult) ?? "undefined").slice(0, 500),
					})

					// Commit fallback state after successful dispatch
					if (plan) {
						const stateToCommit = sessionStates.get(sessionID)
						if (stateToCommit) {
							const committed = commitFallback(stateToCommit, plan)
							if (committed) {
								logInfo(`Committed fallback after compaction summarize (${source})`, {
									sessionID,
									from: plan.failedModel,
									to: plan.newModel,
									attemptCount: stateToCommit.attemptCount,
								})
							}
						}
					}

					scheduleSessionFallbackTimeout(sessionID, undefined)
					retryDispatched = true

					if (config.notify_on_fallback) {
						const fromName = (failedModel || "primary").split("/").pop()!
						const toName = newModel.split("/").pop() || newModel
						await ctx.client.tui
							.showToast({
								body: {
									title: "Compaction Fallback",
									message: `${fromName} failed — retrying compaction on ${toName}`,
									variant: "warning",
									duration: 5000,
								},
							})
							.catch(() => {})
					}

					logInfo(`Compaction re-dispatched via summarize (${source})`, {
						sessionID,
						model: newModel,
					})
					return true
				} catch (summarizeErr) {
					logError(`session.summarize failed (${source})`, {
						sessionID,
						model: newModel,
						error: String(summarizeErr),
					})
					sessionAwaitingFallbackResult.delete(sessionID)

					// Summarize failed — commit fallback state so chat.message
					// override works for regular prompts
					if (plan) {
						const currentState = sessionStates.get(sessionID)
						if (currentState) {
							commitFallback(currentState, plan)
							logInfo(`Committed compaction fallback state as last resort (${source})`, {
								sessionID,
								from: plan.failedModel,
								to: plan.newModel,
							})
						}
					}

					deps.sessionCompactionInFlight.delete(sessionID)
					clearSessionFallbackTimeout(sessionID)
					sessionAwaitingFallbackResult.delete(sessionID)

					if (config.notify_on_fallback) {
						const fromName = (failedModel || "primary").split("/").pop()!
						const toName = newModel.split("/").pop() || newModel
						await ctx.client.tui
							.showToast({
								body: {
									title: "Compaction Failed",
									message: `${fromName} can't compact — try /compact after switching to ${toName}`,
									variant: "warning",
									duration: 10000,
								},
							})
							.catch(() => {})
					}

					deferredToOtherHandler = true
					return false
				}
			}

			// ── NORMAL REPLAY DISPATCH PATH ──
			//
			// The timeout path resolves the replayable message BEFORE aborting
			// and passes it in, so the payload is guaranteed replayable and we
			// re-use that pre-abort selection.  Every other source resolves it
			// here, after its own abort/propagation handling.
			let replaySelection: ReplaySelection | undefined
			if (preparedReplay) {
				replaySelection = preparedReplay
			} else {
				const messagesResp = await ctx.client.session.messages({
					path: { id: sessionID },
					query: { directory: ctx.directory },
				})
				const msgs = messagesResp.data
				if (!msgs || msgs.length === 0) {
					logError(`No messages found in session for auto-retry (${source})`, { sessionID })
				}
				replaySelection = selectReplayableMessage(msgs)
			}

			const replaySource = replaySelection?.source ?? "none"

			if (replaySelection && replaySelection.parts.length > 0) {
				const allParts = replaySelection.parts
				// The id of the replayed user message.  Passing it as the
				// dispatch's messageID makes the runtime upsert that user message
				// (prompt.ts: `id: input.messageID ?? MessageID.ascending()` plus
				// `sessions.updateMessage(info)`) instead of minting a fresh one on
				// every replay, which is what produced duplicate prompts.
				let replayMessageID = replaySelection.messageID

				// The abort that preceded this dispatch can remove the pending
				// user message (the runtime reverts the unconfirmed turn).
				// Upserting the removed id then silently swallows the replay:
				// the loop sees the previous completed assistant message and
				// exits at step 0, leaving the session idle until the user
				// manually re-sends the prompt (observed 2026-09-28T22:35:27Z
				// as a duplicated "Continue").  If the replayed message no
				// longer exists, drop the id so the runtime mints a fresh user
				// message the loop will actually process.
				if (replayMessageID) {
					try {
						const currentResp = await ctx.client.session.messages({
							path: { id: sessionID },
							query: { directory: ctx.directory },
						})
						const stillExists = (currentResp.data ?? []).some(
							(m) =>
								((m?.info?.id ?? (m as any)?.id) as unknown) === replayMessageID,
						)
						if (!stillExists) {
							logInfo(
								"Replayed user message was removed by the abort; dispatching a fresh message",
								{ sessionID, messageID: replayMessageID },
							)
							replayMessageID = undefined
						}
					} catch {
						// Keep the id when the check fails; behaviour unchanged.
					}
				}

				// Second stale check: re-verify after all async work (abort + delay +
				// message fetch).  Another handler may have advanced the state during
				// any of the awaits above.
				const postCheckState = sessionStates.get(sessionID)
				const expectedCurrentModel = plan ? plan.failedModel : newModel
				if (postCheckState && postCheckState.currentModel !== expectedCurrentModel) {
					logInfo(`Skipping stale autoRetryWithFallback (${source}): state already at ${postCheckState.currentModel}, expected failed model ${expectedCurrentModel}`, {
						sessionID,
						staleModel: newModel,
						currentModel: postCheckState.currentModel,
					})
					deferredToOtherHandler = true
					return false
				}


				// If another handler already dispatched and is awaiting a result
				// for this session, skip the duplicate dispatch.
				if (sessionAwaitingFallbackResult.has(sessionID)) {
					logInfo(`Skipping duplicate fallback dispatch — another handler already dispatched (${source})`, {
						sessionID,
						model: newModel,
					})
					deferredToOtherHandler = true
					return false
				}

				// Claim the dispatch slot BEFORE any async work (promptAsync).
				// This prevents a second concurrent handler from also dispatching.
				// Cleared in the finally block if dispatch fails.
				sessionAwaitingFallbackResult.add(sessionID)

				logInfo(`Auto-retrying with fallback model (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
					replaySource,
				})

				logInfo(`Prepared replay payload (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
					replaySource,
					payload: summarizeParts(allParts),
				})

				if (allParts.length > 0) {
					// Build the send function that calls promptAsync
					const sendFn = async (parts: MessagePart[]): Promise<void> => {
						logInfo(`Dispatching fallback replay (${source})`, {
							sessionID,
							model: newModel,
							agent: resolvedAgent,
							payload: summarizeParts(parts),
						})
						await ctx.client.session.promptAsync({
							path: { id: sessionID },
							body: {
								...(resolvedAgent ? { agent: resolvedAgent } : {}),
								// Reuse the original user message id so the runtime
								// upserts this turn instead of appending a new user
								// message on every replay.  Omit the key entirely when
								// no id is available (previous behaviour).
								...(replayMessageID ? { messageID: replayMessageID } : {}),
								model: fallbackModelObj,
								parts,
							},
							query: { directory: ctx.directory },
						})
						logInfo(`Fallback replay accepted by host (${source})`, {
							sessionID,
							model: newModel,
							agent: resolvedAgent,
						})
					}

					const replayResult = await replayWithDegradation(allParts, sendFn)

					if (replayResult.success) {
						// Commit the fallback plan to state NOW — after the API call
						// actually succeeded. This prevents race conditions where
						// session.error sees an advanced state before any API call
						// was made.
						let commitSucceeded = true
						if (plan) {
							const stateToCommit = sessionStates.get(sessionID)
							if (stateToCommit) {
								const committed = commitFallback(stateToCommit, plan)
								if (committed) {
									logInfo(`Committed fallback state after successful dispatch (${source})`, {
										sessionID,
										newModel: plan.newModel,
										failedModel: plan.failedModel,
										attemptCount: stateToCommit.attemptCount,
									})
								} else {
									// Another handler already committed the same plan.
									// We've sent a duplicate replay that we can't un-send.
									// Abort it to prevent the provider from processing
									// two requests for the same session, then bail out
									// so we don't schedule a competing timeout.
									logInfo(`Fallback state already committed by another handler — aborting duplicate replay (${source})`, {
										sessionID,
										newModel: plan.newModel,
									})
									commitSucceeded = false
									await abortSessionRequest(sessionID, `duplicate-replay.${source}`)
								}
							}
						}

						if (!commitSucceeded) {
							// Let the handler that won the commit own the awaiting
							// state and timeout.  Mark ourselves as deferred.
							deferredToOtherHandler = true
							return false
						}

						// sessionAwaitingFallbackResult already set before dispatch
						scheduleSessionFallbackTimeout(sessionID, resolvedAgent)
						retryDispatched = true

						logInfo(`Fallback replay succeeded (${source})`, {
							sessionID,
							tier: replayResult.tier,
							sentPartsCount: replayResult.sentParts?.length,
							droppedTypes: replayResult.droppedTypes,
							replaySource,
						})

						// Show toast if parts were dropped (tier > 1)
						if (replayResult.droppedTypes && replayResult.droppedTypes.length > 0) {
							const droppedStr = replayResult.droppedTypes.join(", ")
							await ctx.client.tui
								.showToast({
									body: {
										title: "Message Replay",
										message: `Some message parts were dropped for compatibility: ${droppedStr}`,
										variant: "warning",
										duration: 5000,
									},
								})
								.catch(() => {})
						}
					} else {
						logError(`All replay tiers failed (${source})`, {
							sessionID,
							error: replayResult.error,
						})
					}
				}
			} else {
				logInfo(`No replayable non-assistant message found for auto-retry (${source})`, {
					sessionID,
					model: newModel,
					agent: resolvedAgent,
				})
			}
		} catch (retryError) {
			logError(`Auto-retry failed (${source})`, {
				sessionID,
				error: String(retryError),
			})
			sessionAwaitingFallbackResult.delete(sessionID)
			deps.sessionCompactionInFlight.delete(sessionID)
			clearSessionFallbackTimeout(sessionID)
		} finally {
			// Note: sessionRetryInFlight is managed by the caller, not here.
			// Don't clear awaiting flag if we deferred to another handler that
			// IS dispatching — they own the flag now.
			if (!retryDispatched && !deferredToOtherHandler) {
				sessionAwaitingFallbackResult.delete(sessionID)
				deps.sessionCompactionInFlight.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				const state = sessionStates.get(sessionID)
				if (state?.pendingFallbackModel) {
					state.pendingFallbackModel = undefined
				}
			}
		}

		return retryDispatched
	}

	const resolveAgentForSessionFromContext = async (
		sessionID: string,
		eventAgent?: string
	): Promise<string | undefined> => {
		const resolved = resolveAgentForSession(sessionID, eventAgent)
		if (resolved) return resolved

		try {
			const messagesResp = await ctx.client.session.messages({
				path: { id: sessionID },
				query: { directory: ctx.directory },
			})
			const msgs = messagesResp.data
			if (!msgs || msgs.length === 0) return undefined

			for (let i = msgs.length - 1; i >= 0; i--) {
				const info = msgs[i]?.info
				const infoAgent = typeof info?.agent === "string" ? info.agent : undefined
				if (infoAgent && infoAgent.trim().length > 0) {
					return infoAgent.trim().toLowerCase()
				}
			}
		} catch {
			logError("Failed to resolve agent from messages", { sessionID })
		}

		try {
			const sessionInfo = await ctx.client.session.get({ path: { id: sessionID } })
			const sessionData = (sessionInfo?.data ?? sessionInfo) as Record<string, unknown>
			const sdkAgent =
				typeof sessionData?.agent === "string" ? sessionData.agent : undefined
			if (sdkAgent && sdkAgent.trim().length > 0) {
				const normalized = sdkAgent.trim().toLowerCase()
				logInfo("Resolved agent from session.get", { sessionID, agent: normalized })
				return normalized
			}
		} catch {
			logError("Failed to resolve agent from session.get", { sessionID })
		}

		return undefined
	}

	const cleanupStaleSessions = () => {
		const now = Date.now()
		let cleanedCount = 0

		for (const [childSessionID, candidate] of deps.sessionRecoveryCandidates.entries()) {
			if (now - candidate.abortedAt > RECOVERY_CANDIDATE_TTL_MS) {
				deps.sessionRecoveryCandidates.delete(childSessionID)
			}
		}

		for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
			if (now - lastAccess > SESSION_TTL_MS) {
				sessionStates.delete(sessionID)
				sessionLastAccess.delete(sessionID)
				sessionRetryInFlight.delete(sessionID)
				sessionAwaitingFallbackResult.delete(sessionID)
				deps.sessionFirstTokenReceived.delete(sessionID)
				deps.sessionSelfAbortTimestamp.delete(sessionID)
				deps.sessionParentID.delete(sessionID)
				deps.sessionIdleResolvers.delete(sessionID)
				deps.sessionLastMessageTime.delete(sessionID)
				deps.sessionCompactionInFlight.delete(sessionID)
				clearSessionFallbackTimeout(sessionID)
				cleanedCount++
			}
		}
		if (cleanedCount > 0) {
			logInfo(`Cleaned up ${cleanedCount} stale session states`)
		}
	}

	return {
		getParentSessionID,
		abortSessionRequest,
		clearSessionFallbackTimeout,
		scheduleSessionFallbackTimeout,
		autoRetryWithFallback,
		resolveAgentForSessionFromContext,
		cleanupStaleSessions,
	}
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
