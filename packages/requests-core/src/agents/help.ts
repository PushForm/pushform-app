// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { carryOver, renderBriefMarkdown } from './brief.ts';
import { editableDocument } from './document.ts';
import { defineTool, withSchema, type ToolHandler } from './client.ts';
import { FRAMING_RULE, withScreenArea, reportEnvironment, type AgentContext, type ConversationAgent, type ConversationStore } from './store.ts';
import { FEEDBACK_RULES, contextBlock, hostName, searchDocsHandler, searchDocsTool, startOverHandler, startOverTool } from './intake.ts';

export const helpSwitchPathSchema = z.object({
  to: z.enum(['problem', 'feature']).describe('problem: Report a problem. feature: Request a feature or change.'),
  reason: z.string().describe('One sentence on why this path fits what the requester described, which they agreed with.'),
});
export const helpSwitchPathTool = defineTool('switch_path', 'Switch this help conversation to Report a problem or Request a feature or change after the requester agreed. When the question is not resolved (the behavior does not exist, is specified differently, or does not work), say so and ask whether to switch; call this only after a yes. The conversation so far carries over and the new path\'s questions start with the next message.', helpSwitchPathSchema);

export function helpHandlers(ctx: AgentContext, store: ConversationStore): Record<string, ToolHandler> {
  const env = reportEnvironment(ctx);
  return {
    search_docs: searchDocsHandler(ctx),
    switch_path: withSchema(helpSwitchPathSchema, async ({ to }) => {
      if (store.getPath() === to) return { content: `The conversation is already on the ${to} path.`, isError: true };
      const next = withScreenArea(carryOver(store.getBrief(), to, env), ctx.screen);
      await store.setBrief(next); await store.setPath(to);
      const ask = 'only an essential detail if it is missing; otherwise show a concise title and summary for sending';
      return `Switched to the ${to} path. Tell the requester in one sentence and ask ${ask}. ${FEEDBACK_RULES}${next ? `\nBrief now:\n${renderBriefMarkdown(next)}` : ''}`;
    }),
    start_over: startOverHandler(store),
  };
}
export function helpTools(_ctx: AgentContext): Anthropic.Tool[] { return [searchDocsTool, helpSwitchPathTool, startOverTool]; }

/** Shared by direct help and the first turn that switches from intake to help. */
export const HELP_PROCEDURE_RULES = `Treat a how-to question as a task to help complete. Give the next concrete action and its purpose, using the documented inputs, picking order, preview and finish/cancel steps when relevant. A control's location alone does not explain how to use it.
If the available passages omit a necessary step, call search_docs now with the exact tool name and missing detail; do not promise to look later or make the requester repeat their goal before doing this routine lookup. Combine relevant passages into a procedure. After confirmed tool activation, continue with the next unfinished step; do not stop at "the tool is chosen" or repeat its location. Use available UI guidance eagerly.
If focused searches still do not cover a step, say plainly that you do not know that step, retain any supported instructions, and never guess undocumented behavior. Ask a clarification only when its answer would change the next instruction, not merely because help is incomplete. A missing passage is a help gap, never evidence that a feature is unavailable; do not offer filing merely because search missed it.`;

export const HELP_SYSTEM = (ctx: AgentContext) => `You are the Help assistant inside ${hostName(ctx)}. You talk with a signed-in user through a side panel. Be brief and concrete; plain sentences, no headings, at most three bullet items.

Rules:
- Answer only from the user-facing help guides in <retrieved_help> or search_docs results. Use the prefetched passages immediately when sufficient; call search_docs only for missing details. Explain the steps plainly without internal references.
- Answer for the current editor in <context>; do not mix Modeling instructions into a Layout answer unless the requester asks for a comparison. When search returns only part of a procedure, search again for the missing detail (for example polygon sides or Measurements) before concluding it is undocumented.
- ${HELP_PROCEDURE_RULES}
- Never ask for anything in <context>: the account email, the document type, the build, the browser or the time.
- ${FRAMING_RULE}
- ${ctx.document?.guidance ? `You file nothing; temporary UI guidance is allowed as the guidance rules below describe.${editableDocument(ctx.document) ? ' You edit the open document only as the document rules allow.' : ''}` : editableDocument(ctx.document) ? 'You file nothing, and you change nothing except the open document, only as the document rules below describe.' : 'You file nothing and change nothing.'} When the question is not resolved, because the behavior does not exist, works differently from what the user needs, or does not work as the help describes, say so in one sentence and ask whether they want to report a problem or request a feature or change; call switch_path only after their latest message says yes. For procedural help, end with the next useful instruction or wait for the interaction; do not append a generic "Did that answer your question?" or ask permission to look up routine steps.
- Starting over: when the user clearly asks to start over or drop this conversation, call start_over and say in one sentence that their next message starts fresh.
- Do not promise fixes or features.`;

/** The help path: answers from the digest, files nothing, switches paths only after a yes. */
export const helpAgent: ConversationAgent = {
  system: HELP_SYSTEM,
  context: contextBlock,
  tools: helpTools,
  handlers: helpHandlers,
};
