import { describe, test, expect, beforeEach } from "bun:test"
import {
	shouldLogActivity,
	resetActivityLogThrottle,
} from "./activity-log-throttle"

describe("shouldLogActivity", () => {
	beforeEach(() => {
		resetActivityLogThrottle()
	})

	test("first activity logs", () => {
		expect(shouldLogActivity("ses_a", 1_000)).toEqual({ log: true, suppressed: 0 })
	})

	test("streaming activity within the window is suppressed and counted", () => {
		shouldLogActivity("ses_a", 1_000)
		expect(shouldLogActivity("ses_a", 1_050)).toEqual({ log: false, suppressed: 0 })
		expect(shouldLogActivity("ses_a", 1_100)).toEqual({ log: false, suppressed: 0 })
	})

	test("the next line reports how many events were suppressed", () => {
		shouldLogActivity("ses_a", 1_000)
		for (let t = 1_050; t < 11_000; t += 50) shouldLogActivity("ses_a", t)
		const decision = shouldLogActivity("ses_a", 11_100)
		expect(decision.log).toBe(true)
		expect(decision.suppressed).toBeGreaterThan(100)
	})

	test("sessions are throttled independently", () => {
		shouldLogActivity("ses_a", 1_000)
		expect(shouldLogActivity("ses_b", 1_050)).toEqual({ log: true, suppressed: 0 })
	})
})
