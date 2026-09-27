import type { HookDeps, ChatMessageInput, ChatMessageOutput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState, isModelInCooldown, recoverToOriginal } from "./fallback-state"
import { logInfo, logError } from "./logger"

export function createChatMessageHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
	const {
		ctx,
		config,
		sessionStates,
		sessionLastAccess,
		sessionRetryInFlight,
		sessionAwaitingFallbackResult,
	} = deps

	return async (input: ChatMessageInput, output: ChatMessageOutput) => {
		if (!config.enabled) return

		const { sessionID } = input
		let state = sessionStates.get(sessionID)

		if (!state) {
			return
		}

		sessionLastAccess.set(sessionID, Date.now())

		const requestedModel = input.model
			? `${input.model.providerID}/${input.model.modelID}`
			: undefined

		// If the user explicitly requests the model they're already on (the
		// fallback), adopt it as the new primary.  Without this, the recovery
		// logic would later "recover" back to the old originalModel when its
		// cooldown expires — even though the user deliberately chose to stay
		// on the current model.  This prevents a spurious "Recovered to X"
		// notification after a manual model selection.
		//
		// IMPORTANT: This check must happen BEFORE the recovery check below.
		// Otherwise recovery fires first, resetting to originalModel, and the
		// adoption check never sees the mismatch.
		//
		// SKIP when the plugin is actively managing a fallback: when
		// sessionRetryInFlight, sessionAwaitingFallbackResult, or
		// sessionCompactionInFlight is set, the chat.message event is from
		// the plugin's own promptAsync replay — NOT a deliberate user
		// adoption.  Without this guard, the replay's chat.message resets
		// the fallback state (clears failedModels, resets fallbackIndex)
		// which breaks the fallback chain and can cause an "interrupted"
		// loop when the fallback model itself errors.
		if (
			requestedModel &&
			requestedModel === state.currentModel &&
			state.currentModel !== state.originalModel &&
			!deps.sessionCompactionInFlight.has(sessionID) &&
			!sessionRetryInFlight.has(sessionID) &&
			!sessionAwaitingFallbackResult.has(sessionID)
		) {
			logInfo("Adopting current model as new primary (user confirmed manual selection)", {
				sessionID,
				model: requestedModel,
				previousOriginal: state.originalModel,
			})
			state.originalModel = requestedModel
			state.failedModels.clear()
			state.quotaFailures.clear()
			state.fallbackIndex = -1
			state.attemptCount = 0
			// A newly adopted primary deserves a fresh recovery budget.
			state.recoveryProbes = 0
			return
		}

		// Auto-recovery: check if primary model's cooldown has expired, but
		// only while this session still has probe budget left.  A session may
		// self-heal to its primary a bounded number of times; once the budget
		// is spent it stays parked on the fallback leg so a still-bad primary
		// cannot cost another TTFT timeout + prompt replay every cooldown
		// window for the rest of the session's life.
		const recoveryBudgetExhausted =
			state.recoveryProbes >= config.max_recovery_probes

		if (state.currentModel !== state.originalModel) {
			if (
				!recoveryBudgetExhausted &&
				!sessionRetryInFlight.has(sessionID) &&
				!sessionAwaitingFallbackResult.has(sessionID)
			) {
				const recovered = recoverToOriginal(
					state,
					config.cooldown_seconds,
					config.quota_cooldown_seconds
				)
				if (recovered) {
					state.recoveryProbes++
					logInfo("Recovered to primary model", {
						sessionID,
						model: state.originalModel,
					})
					// Log the transition into "budget spent" exactly once per
					// session: only the probe that reaches the cap can emit it,
					// so later turns (where recovery is simply declined) do not
					// repeat the line.
					if (state.recoveryProbes >= config.max_recovery_probes) {
						logInfo(
							"Recovery probe budget exhausted; session will stay on the fallback leg",
							{
								sessionID,
								recoveryProbes: state.recoveryProbes,
								maxRecoveryProbes: config.max_recovery_probes,
							}
						)
					}
					if (config.notify_on_fallback) {
						const modelName = state.originalModel.split("/").pop() || state.originalModel
						ctx.client.tui
							.showToast({
								body: {
									title: "Model Recovered",
									message: `Recovered to ${modelName}`,
									variant: "info",
									duration: 3000,
								},
							})
							.catch(() => {})
					}
				}
			}
		}

		if (requestedModel && requestedModel !== state.currentModel) {
			if (
				state.pendingFallbackModel &&
				state.pendingFallbackModel === requestedModel
			) {
				state.pendingFallbackModel = undefined
				return
			}

			// If the plugin is actively managing a fallback (retry in flight
			// or awaiting result), any model mismatch is from the plugin's own
			// promptAsync replay — NOT a manual user change.  Skip entirely and
			// let commitFallback handle the state transition atomically.
			//
			// Previously this guard additionally required the requestedModel to
			// be in the fallback_models list, but that check is fragile: agent
			// resolution in the chat.message context can differ from the agent
			// used during fallback planning (e.g. compaction clears the agent),
			// causing getFallbackModelsForSession to return a different list.
			// The retry-in-flight / awaiting-result flags are authoritative.
			if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
				logInfo("Ignoring model mismatch during active fallback management", {
					sessionID,
					requestedModel,
					currentModel: state.currentModel,
					retryInFlight: sessionRetryInFlight.has(sessionID),
					awaitingResult: sessionAwaitingFallbackResult.has(sessionID),
				})
				return
			}

			// The host re-resolves each turn's model from the persisted session
			// model, so the next turn after a fallback normally arrives as the
			// ORIGINAL primary — not as a deliberate user change. While that
			// primary is in cooldown, the cooldown is the authoritative signal
			// that its leg is bad: keep the session on the recovery leg and let
			// the override below re-apply it for this turn.
			//
			// Resetting here (2026-09-27) put every turn back on the leg that
			// had just stalled: each one re-hit the 30s TTFT timeout and
			// replayed the user's prompt. One session logged 17 timeouts / 14
			// replays / 8 resets / 0 overrides in ~80 minutes — a duplicated
			// prompt dispatch roughly every 2.5 minutes.
			const primaryInCooldown = isModelInCooldown(
				state.originalModel,
				state,
				config.cooldown_seconds,
				config.quota_cooldown_seconds
			)

			// When the recovery budget is spent, the re-asserted primary is
			// still not trustworthy even after its cooldown expires — keep the
			// fallback leg rather than resetting to a leg we deliberately
			// stopped probing.  The one-time "budget exhausted" log already
			// fired when the last probe was spent, so this path stays silent
			// (do not log per turn).
			if (
				requestedModel === state.originalModel &&
				(primaryInCooldown || recoveryBudgetExhausted)
			) {
				if (primaryInCooldown) {
					logInfo("Primary re-asserted while in cooldown; keeping the fallback leg", {
						sessionID,
						requestedModel,
						currentModel: state.currentModel,
					})
				}
			} else {
				logError("Detected manual model change, resetting fallback state", {
					sessionID,
					from: state.currentModel,
					to: requestedModel,
				})

				helpers.clearSessionFallbackTimeout(sessionID)
				sessionAwaitingFallbackResult.delete(sessionID)
				// Reset first-token tracking so the new model gets a fresh TTFT window.
				// Without this, the new model inherits firstTokenReceived=true from the
				// old model and TTFT is never scheduled.
				deps.sessionFirstTokenReceived.delete(sessionID)

				if (sessionRetryInFlight.has(sessionID)) {
					await helpers.abortSessionRequest(sessionID, "manual-model-change")
					sessionRetryInFlight.delete(sessionID)
				}

				state = createFallbackState(requestedModel)
				sessionStates.set(sessionID, state)
				return
			}
		}

		if (state.currentModel === state.originalModel) return

		const activeModel = state.currentModel

		logInfo("Applying fallback model override", {
			sessionID,
			from: input.model,
			to: activeModel,
		})

		if (output.message && activeModel) {
			const parts = activeModel.split("/")
			if (parts.length >= 2) {
				output.message.model = {
					providerID: parts[0],
					modelID: parts.slice(1).join("/"),
				}
			}
		}

		// Clear compaction-in-flight at the very end, AFTER all guards
		// and the model override have been applied.  Clearing it earlier
		// would let the adoption guard (which checks !compactionInFlight)
		// reset the fallback state before the override takes effect.
		deps.sessionCompactionInFlight.delete(sessionID)
	}
}
