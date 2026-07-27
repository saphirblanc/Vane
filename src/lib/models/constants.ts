/**
 * Sent when neither the request nor the provider config specifies a limit.
 *
 * Leaving it undefined means the upstream default applies, and several
 * providers default low enough to truncate a Quality-mode answer mid-sentence.
 */
export const DEFAULT_MAX_TOKENS = 16384;
