/** Default idle period before an interactive Pi session closes itself. */
export const IDLE_LIMIT_MS = 48 * 60 * 60 * 1000;
/** How often the session checks; the limit is measured on the wall clock, so time asleep counts as idle. */
export const CHECK_INTERVAL_MS = 10 * 60 * 1000;

interface SessionState {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
}

/**
 * Tracks the last activity of one session and decides when it has been idle long enough to close.
 * A session never closes while the agent is working or a message is queued for it.
 */
export function createIdleExit({ limitMs = IDLE_LIMIT_MS, now = Date.now } = {}) {
  let lastActivity = now();
  return {
    touch() {
      lastActivity = now();
    },
    shouldExit(session: SessionState): boolean {
      if (!session.isIdle() || session.hasPendingMessages()) return false;
      return now() - lastActivity >= limitMs;
    },
  };
}
