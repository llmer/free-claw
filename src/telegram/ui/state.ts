/**
 * In-memory onboarding wizard state.
 * Lost on restart — user just re-runs /setup.
 */

const TTL_MS = 30 * 60_000; // 30 minutes

export type OnboardingStep =
  | "name" | "name_custom"
  | "creature" | "creature_custom"
  | "vibe" | "vibe_custom"
  | "emoji" | "emoji_custom"
  | "user_name"
  | "user_tz" | "user_tz_custom"
  | "confirm";

export type OnboardingState = {
  step: OnboardingStep;
  name?: string;
  creature?: string;
  vibe?: string;
  emoji?: string;
  userName?: string;
  userTimezone?: string;
  messageId?: number; // wizard message to edit in-place
  startedAt: number;
};

const states = new Map<number, OnboardingState>();

function isExpired(state: OnboardingState): boolean {
  return Date.now() - state.startedAt > TTL_MS;
}

export function getOnboardingState(chatId: number): OnboardingState | undefined {
  const state = states.get(chatId);
  if (!state) return undefined;
  if (isExpired(state)) {
    states.delete(chatId);
    return undefined;
  }
  return state;
}

export function setOnboardingState(chatId: number, state: OnboardingState): void {
  states.set(chatId, state);
}

export function clearOnboardingState(chatId: number): void {
  states.delete(chatId);
}

/**
 * Returns true if the chat has an active onboarding state
 * AND is currently waiting for text input (step ends with _custom or is user_name).
 */
export function hasActiveOnboarding(chatId: number): boolean {
  const state = getOnboardingState(chatId);
  if (!state) return false;
  return state.step.endsWith("_custom") || state.step === "user_name";
}
