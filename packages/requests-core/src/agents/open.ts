// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { carryOver, renderBriefMarkdown } from './brief.ts';
import { editableDocument } from './document.ts';
import { defineTool, withSchema, type ToolHandler } from './client.ts';
import { briefHandlers, briefTools, COMMON_RULES, FEEDBACK_RULES, contextBlock, hostName, LIMIT_RULES, openingQuestion } from './intake.ts';
import { problemOpeningQuestion } from './problem.ts';
import { HELP_PROCEDURE_RULES } from './help.ts';
import { withScreenArea, reportEnvironment, type AgentContext, type ConversationAgent, type ConversationStore } from './store.ts';

/**
 * The agent of a conversation whose path is still `open`: the requester typed instead of choosing a card.
 * It reads the first message, settles the path with `switch_path` (no confirmation for this first choice;
 * applies to every later switch) and continues on that path in the same turn with the path's own tools. When the
 * message does not tell, it asks one short question offering the three choices and leaves the path open.
 */
export const openSwitchPathSchema = z.object({
  to: z.enum(['help', 'problem', 'feature']).describe('help: a question about using the product. problem: something specified or that used to work does not. feature: behavior that does not exist or should work differently.'),
  reason: z.string().describe('One sentence on what in the message points to this path.'),
});
export const openSwitchPathTool = defineTool('switch_path', 'Settle the path of this conversation from the requester\'s first message: help, problem or feature. Call it once, without asking, as soon as the message shows what they need; then continue on that path in this same turn. Do not call it when the message could be any of the three; ask instead. Returns what to do next.', openSwitchPathSchema);

const AFTER_SWITCH: Record<'help' | 'problem' | 'feature', (ctx: AgentContext) => string> = {
  help: (ctx) => `${ctx.document ? 'If they asked for a change to the open document, make it now with the layout tools as the document rules describe. Otherwise n' : 'N'}ow answer as the Help assistant of ${hostName(ctx)}: use the current <retrieved_help> passages when sufficient, otherwise call search_docs for missing details; answer only from these help passages, using short practical steps without internal references. ${HELP_PROCEDURE_RULES} File nothing. If the question turns out to be a problem or a missing feature, say that they can report it or request it in their next message.`,
  problem: () => 'Now continue as the problem path: record with update_brief what the message already gives (steps, what they expected, what happened), then show a concise title/summary for sending, asking at most one essential clarification only if the problem cannot be understood. Never ask for the build, browser, operating system or document type.',
  feature: () => 'Now continue as the feature path: record with update_brief what the message already gives (the problem they cannot solve today, the desired behavior), call search_docs to check whether the behavior already exists, call search_open_issues, then ask the first question still open.',
};

export function openHandlers(ctx: AgentContext, store: ConversationStore): Record<string, ToolHandler> {
  const env = reportEnvironment(ctx);
  return {
    ...briefHandlers(ctx, store),
    switch_path: withSchema(openSwitchPathSchema, async ({ to }) => {
      const current = store.getPath();
      if (current !== 'open') return { content: `The conversation is already on the ${current} path. Continue on it; a later switch needs the requester's agreement first.`, isError: true };
      const next = withScreenArea(carryOver(null, to, env), ctx.screen);
      await store.setBrief(next); await store.setPath(to);
      return `Path set to ${to}. ${AFTER_SWITCH[to](ctx)} ${to === 'help' ? '' : FEEDBACK_RULES}${next ? `\nBrief now:\n${renderBriefMarkdown(next)}` : ''}`;
    }),
  };
}
/** The brief tools of the two filing paths plus search_docs for help, with `switch_path` replaced by the three-way first choice; nothing can be filed before a path is set and the brief was shown. */
export function openTools(ctx: AgentContext): Anthropic.Tool[] {
  const tools = briefTools(ctx).filter((t) => t.name !== 'switch_path' && t.name !== 'request_file');
  return [openSwitchPathTool, ...tools];
}

export const OPEN_SYSTEM = (ctx: AgentContext) => `${COMMON_RULES(ctx)}

For procedural help: ${HELP_PROCEDURE_RULES}

The requester has not chosen a path yet: they typed instead of picking Get help, Report a problem or Request a feature or change. Read their message and decide which of the three they need:
- help: they ask how to do something or how the product behaves (answer it: "${hostName(ctx)}" documentation in <retrieved_help> or search_docs)${ctx.document ? ', or they ask you to change the open document (settle on help, then make the change with the layout tools)' : ''};
- problem: something that is specified or used to work does not, crashes, or gives a wrong result (the problem path opens with "${problemOpeningQuestion(ctx)}");
- feature: they want behavior that does not exist or should work differently (the feature path opens with "${openingQuestion(ctx)}").
When the message shows the path, call switch_path at once, without asking, and continue on that path in this same turn exactly as the tool result tells you: answer the help question, or record what the message already gives and ask that path's first open question. This first choice needs no confirmation; afterwards this rule applies and any further switch is asked first.
When the message could be any of the three (a greeting, a bare topic, "I have a question about tables"), do not call switch_path: reply with one short sentence offering the three choices, for example "Happy to help. Do you want help using ${hostName(ctx)}, to report a problem, or to request a feature or change?", and nothing else.
Until the path is set there is no brief: never call update_brief, set_brief_choice, estimate_class or propose_title before switch_path. Nothing is filed in this turn: when the message already asks to send something, record it, show what you have and ask for the rest first.

Help rules once the path is help: answer only from <retrieved_help> or search_docs results, using sufficient prefetched passages without a redundant search and short practical steps without internal references; when the documentation does not cover the question, say plainly that you do not know and never guess; ${ctx.document?.guidance ? `you file nothing; temporary UI guidance is allowed as the guidance rules describe${editableDocument(ctx.document) ? ', and editing the open document follows the document rules' : ''}` : editableDocument(ctx.document) ? 'you file nothing, and you change nothing except the open document, only as the document rules below describe' : 'you file nothing and change nothing'}; when the question is not resolved because the behavior does not exist or does not work, say in one sentence that they can report a problem or request a feature in their next message; for procedural help give the next useful action and use available guidance proactively, without a generic satisfaction question. Missing help content is not evidence that the feature is missing; refine the search instead of pitching a feature request.${LIMIT_RULES(ctx)}`;

/** The open path: settles help, problem or feature from the first message and continues as that path. */
export const openAgent: ConversationAgent = {
  system: OPEN_SYSTEM,
  context: contextBlock,
  tools: openTools,
  handlers: openHandlers,
};
