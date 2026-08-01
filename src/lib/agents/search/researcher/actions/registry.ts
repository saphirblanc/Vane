import { Tool, ToolCall } from '@/lib/models/types';
import {
  ActionOutput,
  AdditionalConfig,
  ClassifierOutput,
  ResearchAction,
  SearchAgentConfig,
  SearchSources,
} from '../../types';

class ActionRegistry {
  private static actions: Map<string, ResearchAction> = new Map();

  static register(action: ResearchAction<any>) {
    this.actions.set(action.name, action);
  }

  static get(name: string): ResearchAction | undefined {
    return this.actions.get(name);
  }

  static getAvailableActions(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): ResearchAction[] {
    return Array.from(
      this.actions.values().filter((action) => action.enabled(config)),
    );
  }

  static getAvailableActionTools(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): Tool[] {
    const availableActions = this.getAvailableActions(config);

    return availableActions.map((action) => ({
      name: action.name,
      description: action.getToolDescription({ mode: config.mode }),
      schema: action.schema,
    }));
  }

  static getAvailableActionsDescriptions(config: {
    classification: ClassifierOutput;
    fileIds: string[];
    mode: SearchAgentConfig['mode'];
    sources: SearchSources[];
  }): string {
    const availableActions = this.getAvailableActions(config);

    return availableActions
      .map(
        (action) =>
          `<tool name="${action.name}">\n${action.getDescription({ mode: config.mode })}\n</tool>`,
      )
      .join('\n\n');
  }

  static async execute(
    name: string,
    params: any,
    additionalConfig: AdditionalConfig & {
      researchBlockId: string;
      fileIds: string[];
      mode: SearchAgentConfig['mode'];
    },
  ) {
    const action = this.actions.get(name);

    if (!action) {
      throw new Error(`Action with name ${name} not found`);
    }

    return action.execute(params, additionalConfig);
  }

  static async executeAll(
    actions: ToolCall[],
    additionalConfig: AdditionalConfig & {
      researchBlockId: string;
      fileIds: string[];
      mode: SearchAgentConfig['mode'];
    },
  ): Promise<ActionOutput[]> {
    const results: ActionOutput[] = [];

    /* Indexed rather than pushed: the caller pairs `results[i]` with the tool
     * call it sent as `actions[i]` to build the tool messages, and `push` under
     * `Promise.all` orders by completion instead. A turn of
     * `[web_search, __reasoning_preamble]` - DeepSeek emits exactly that order -
     * has the preamble resolve first, so the search's `tool_call_id` was
     * answered with the preamble's output and vice versa. */
    await Promise.all(
      actions.map(async (actionConfig, index) => {
        const output = await this.execute(
          actionConfig.name,
          actionConfig.arguments,
          additionalConfig,
        );
        results[index] = output;
      }),
    );

    return results;
  }
}

export default ActionRegistry;
