import configManager from '@/lib/config';
import ModelRegistry from './registry';
import BaseLLM from './base/llm';

/**
 * Resolves the model used for the classification step that precedes every
 * search.
 *
 * That step is a single short structured call, but it blocks the whole
 * pipeline: nothing else starts until it returns, and measured against
 * DeepSeek V4 Flash it cost between 7 and 19 seconds of a 64-second query.
 * Pointing it at a small fast model takes that off the front of every request
 * without touching the model that actually writes the answer.
 *
 * The key is looked up in the chat model's own provider first, then in every
 * other provider that has it configured. Without the second step a chat on a
 * provider that lacks the key - Hetzner, against an OpenRouter classifier -
 * silently classified with its own slow chat model instead. The trade-off is
 * that such a chat's query also reaches the classifier's provider.
 *
 * Deliberately forgiving. The setting is free text, so a typo or a model the
 * provider has retired has to degrade to the chat model rather than fail the
 * request - the classifier being slow is a nuisance, the search not running at
 * all is not.
 */
export const loadClassifierModel = async (
  registry: ModelRegistry,
  providerId: string,
  fallback: BaseLLM<any>,
): Promise<BaseLLM<any>> => {
  const key = String(
    configManager.getConfig('search.classifierModel', '') ?? '',
  ).trim();

  if (!key) return fallback;

  const candidates = [
    providerId,
    ...registry.activeProviders
      .filter(
        (p) => p.id !== providerId && p.chatModels?.some((m) => m.key === key),
      )
      .map((p) => p.id),
  ];

  for (const candidate of candidates) {
    try {
      return await registry.loadChatModel(candidate, key);
    } catch (err) {
      if (candidate === candidates[candidates.length - 1]) {
        console.error(
          `Classifier model "${key}" could not be loaded, falling back to the chat model:`,
          err,
        );
      }
    }
  }

  return fallback;
};
