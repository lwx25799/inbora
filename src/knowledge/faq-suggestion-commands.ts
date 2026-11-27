import { FaqSuggestionService, type AdoptFaqOverrides, type FaqSuggestion } from '../app/reply-pipeline/faq-suggestions.js';
import type { KnowledgeEntry } from '../contracts/knowledge.js';
import type { KnowledgeCommand } from '../contracts/knowledge-commands.js';
import type { EventStore } from '../storage/store.js';
import type { ReplyKnowledgeStore } from './store.js';

export type FaqSuggestionCommand = Extract<
  KnowledgeCommand,
  { action: 'listFaqSuggestions' | 'generateFaqSuggestions' | 'adoptFaqSuggestion' | 'dismissFaqSuggestion' }
>;

export interface AdoptFaqCommandResult {
  suggestion: FaqSuggestion;
  entry: KnowledgeEntry;
}

export function handleFaqSuggestionCommand(
  store: EventStore,
  data: ReplyKnowledgeStore,
  accountId: string,
  command: FaqSuggestionCommand,
  now: () => number = Date.now,
): unknown {
  const service = new FaqSuggestionService(store, now);
  switch (command.action) {
    case 'listFaqSuggestions':
      return service.listSuggestions(command.status);
    case 'generateFaqSuggestions':
      return service.generateSuggestions(
        command.minClusterSize !== undefined ? { minClusterSize: command.minClusterSize } : {},
      );
    case 'adoptFaqSuggestion': {
      const overrides: AdoptFaqOverrides = {
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.topic !== undefined ? { topic: command.topic } : {}),
        ...(command.text !== undefined ? { text: command.text } : {}),
        ...(command.aliases !== undefined ? { aliases: command.aliases } : {}),
        ...(command.channels !== undefined ? { channels: command.channels } : {}),
      };
      return store.db
        .transaction((): AdoptFaqCommandResult => {
          const { suggestion, knowledgeDraft } = service.adoptSuggestion(command.suggestionId, overrides);
          const saved = data.saveKnowledge(accountId, knowledgeDraft);
          const entry =
            command.activate === false ? saved : data.setKnowledgeState(accountId, saved.id, 'ACTIVE');
          return { suggestion, entry };
        })
        .immediate();
    }
    case 'dismissFaqSuggestion':
      return service.dismissSuggestion(command.suggestionId);
  }
}
