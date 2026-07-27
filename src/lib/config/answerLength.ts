/**
 * Per-mode answer length targets.
 *
 * This module deliberately imports nothing. Both the config registry (which
 * needs the defaults to render the Settings fields) and the writer prompt
 * (which needs them as a fallback) depend on it, and routing that through the
 * ConfigManager singleton would make the import cycle.
 */

export type OptimizationMode = 'speed' | 'balanced' | 'quality';

export const ANSWER_LENGTH_DEFAULTS: Record<OptimizationMode, number> = {
  speed: 200,
  balanced: 500,
  quality: 2000,
};

/* An upper bound on what a user can type into the box, not on the answer. */
export const ANSWER_LENGTH_MAX = 50000;

/**
 * Parses a user-supplied word target. The Settings field is free text, so a
 * missing, blank or unparseable value has to fall back to the default for the
 * mode rather than reach the prompt as `NaN`.
 */
export const parseAnswerLength = (
  value: unknown,
  mode: OptimizationMode,
): number => {
  const fallback =
    ANSWER_LENGTH_DEFAULTS[mode] ?? ANSWER_LENGTH_DEFAULTS.balanced;

  const parsed = parseInt(String(value ?? '').trim(), 10);

  if (Number.isFinite(parsed) && parsed > 0 && parsed <= ANSWER_LENGTH_MAX) {
    return parsed;
  }

  return fallback;
};
