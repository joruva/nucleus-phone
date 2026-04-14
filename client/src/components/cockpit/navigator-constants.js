/**
 * Shared constants for the Conversation Navigator.
 * Kept here (not in the hook or any single component) so the hook's
 * history cap and the arc's x-axis point count can't drift apart.
 */

/** Max sentiment readings retained on the client (matches backend cap). */
export const SENTIMENT_HISTORY_MAX = 20;
