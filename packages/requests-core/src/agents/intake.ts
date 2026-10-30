// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { defineTool, withSchema, type ToolHandler, type ToolResult } from './client.ts';
import { DECLINE_MESSAGES, carryOver, completeness, renderBriefMarkdown, setChoiceSection, setEstimatedClass, setTextSection, validateTitle } from './brief.ts';
import { retrieveUserHelp } from './digest.ts';
import { FRAMING_RULE, defuseFraming, frameRequesterText, withScreenArea, reportEnvironment, type AgentContext, type ConversationAgent, type ConversationStore, type FiledRequestSummary, type OpenIssueSummary } from './store.ts';

/* ---------- tools shared by the feature, problem and help agents ---------- */

export const searchDocsSchema = z.object({ query: z.string().min(1).max(300).describe('A specific task, such as draw an eight-sided polygon. One topic per call.'), editor: z.enum(['current', 'model', 'layout', 'all']).default('current').describe('Use current unless the requester asks about another editor.') });
export const searchDocsTool = defineTool('search_docs', 'Search the user-facing help guides in docs/help only. Use it before saying whether a behavior exists and before answering any question about how the product works. Returns at most three short task passages for the current editor within a fixed context budget.', searchDocsSchema);
export function searchDocsHandler(ctx: AgentContext): ToolHandler {
  return withSchema(searchDocsSchema, ({ query, editor }) => {
    const current = ctx.document?.type ?? ctx.screen.editor;
    return retrieveUserHelp(ctx.digest, query, editor === 'current' ? current : editor);
  });
}

export const searchOpenIssuesSchema = z.object({ query: z.string().describe('Keywords describing the request, or an issue key such as FRQ-12.') });
export const searchOpenIssuesTool = defineTool('search_open_issues', 'Search the open requests already in the tracker by title and summary. Call it once you understand what the requester wants, before gathering the rest of the brief; when one matches, show its key and title and offer "Add me".', searchOpenIssuesSchema);
export function formatIssue(i: OpenIssueSummary): string {
  return `${i.key} (issue_id ${i.id}, ${i.kind}, ${i.state}${i.requestId ? ', filed in-app' : ''})\n${frameRequesterText(`${i.title}\n${i.summary}`, 'issue')}`;
}
export function searchOpenIssuesHandler(store: ConversationStore): ToolHandler {
  return withSchema(searchOpenIssuesSchema, async ({ query }) => {
    const found = await store.searchOpenIssues(query);
    return found.length ? found.slice(0, 5).map(formatIssue).join('\n\n') : 'No open request matches. Continue with a new request.';
  });
}

export const updateBriefSchema = z.object({
  section: z.enum(['problem', 'workaround', 'desired', 'acceptance', 'mustNotChange', 'importanceReason', 'steps', 'expected', 'happened'])
    .describe('Feature brief: problem, workaround, desired, acceptance (one "When I ..., then ..." per line), mustNotChange, importanceReason. Problem report: steps (one per line), expected, happened.'),
  text: z.string().max(4000).nullable().describe('The requester\'s own words, lightly tidied; at most 4000 characters. null clears the section back to "Not provided".'),
});
export const updateBriefTool = defineTool('update_brief', 'Record one section of the brief from what the requester just said or confirmed. Never write content the requester did not give; a skipped question stays "Not provided". Returns the full brief as the requester now sees it.', updateBriefSchema);
export const setBriefChoiceSchema = z.object({
  section: z.enum(['kind', 'area', 'importance', 'frequency', 'impact']).describe('kind: feature | ux-change. area: Modeling | Layout | Cloud | Shell. importance: nice | important | blocking. frequency: always | sometimes | once. impact: cannot_work | workaround | cosmetic.'),
  choice: z.string().nullable().describe('One of the listed options, or null to clear (kind cannot be cleared).'),
});
export const setBriefChoiceTool = defineTool('set_brief_choice', 'Set a fixed-choice section of the brief: Kind (from the conversation), Area, Importance level, How often, or Impact. Returns the full brief.', setBriefChoiceSchema);
export const estimateClassSchema = z.object({
  changeClass: z.enum(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']),
  reason: z.string().describe('One sentence on which parts of the product would change.'),
});
export const estimateClassTool = defineTool('estimate_class', `Record the highest change class the request would touch: C1 content and copy; C2 presentation, layout, shortcuts; C3 existing feature behavior; C4 new feature in an existing area; C5 file format, data model, schema, import/export; C6 build, CI, deployment, dependencies, desktop shell; C7 authentication, authorization, billing, secrets. Call it once the desired behavior is known and again if it changes. The requester cannot edit this section.`, estimateClassSchema);
export const proposeTitleSchema = z.object({ title: z.string().describe('At most 80 characters, imperative or noun phrase, no trailing period.') });
export const proposeTitleTool = defineTool('propose_title', 'Set the proposed issue title. Call it when you show the concise review and whenever the requester asks to change the title.', proposeTitleSchema);
export const switchPathSchema = z.object({
  to: z.enum(['problem', 'feature']).describe('problem: something that used to work or is specified does not. feature: behavior that does not exist or should work differently.'),
  reason: z.string().describe('One sentence the requester already agreed with.'),
});
export const switchPathTool = defineTool('switch_path', 'Switch between the problem report and the feature request after the requester agreed to it. Record what the requester already said with update_brief first, say what you noticed and ask; call this only after a yes. Recorded answers carry over, so never ask them again. Returns the brief on the new path.', switchPathSchema);
export const addMeSchema = z.object({
  issueId: z.string().describe('The issue_id from search_open_issues.'),
  notes: z.string().max(4000).describe('What the requester adds to the existing request, in their words; empty when nothing.'),
});
export const addMeTool = defineTool('add_me', 'Add the requester to an existing open request after you named its key and title in the chat and they said yes in their latest message. Records their interest and notes on that request, subscribes them to its updates and files nothing new; the conversation is complete afterwards. Never call it without that yes.', addMeSchema);
export const declineSchema = z.object({
  reason: z.enum(['abusive', 'off_topic', 'empty']).describe('abusive: the content is abusive. off_topic: nothing to do with the product. empty: neither Problem nor Desired behavior given after asking.'),
});
export const declineTool = defineTool('decline', 'Decline to file. Tell the requester which reason applies, in one sentence; they can start over or stop.', declineSchema);
export const requestFileSchema = z.object({ confirmation: z.string().describe('The requester\'s own words from their latest message that confirm sending the brief, for example "yes, send it".') });
export const requestFileTool = defineTool('request_file', 'File the brief as a tracker issue. Call it only after you have shown the concise summary and the proposed title in the chat and the requester\'s latest message explicitly confirms sending it. Returns the issue key and what happens next, or what blocks the filing.', requestFileSchema);
export const startOverSchema = z.object({ reason: z.string().describe('One sentence: what the requester said that asks to start over or drop this request.') });
export const startOverTool = defineTool('start_over', 'Discard this conversation and its brief because the requester clearly asked to start over or drop the request. When anything substantial has been gathered, ask once whether they really want to drop it and call this only after a yes; otherwise call it at once. The next message starts a new conversation.', startOverSchema);

const briefView = (store: ConversationStore): string => { const b = store.getBrief(); return b ? `Brief now:\n${renderBriefMarkdown(b, store.getTitle())}` : 'No brief on this path.'; };
const err = (content: string): ToolResult => ({ content, isError: true });
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/** What happens after filing, per eligibility, for the agent to put in its own words. */
export const NEXT_STEPS: Record<FiledRequestSummary['eligibility'], string> = {
  auto: 'an agent build starts automatically and the requester will be invited to try the result',
  gated: 'a maintainer reviews the request and decides whether an agent build starts; the requester is invited to the trial when it does',
  none: 'a maintainer reviews the request as an ordinary ticket',
};
export function filedResult(r: FiledRequestSummary, verb: 'Filed' | 'Added the requester to'): string {
  return `${verb} ${r.issueKey} "${r.title}". Next: ${NEXT_STEPS[r.eligibility]}; the requester gets email updates at their account address. Tell them this in your own words in one or two sentences, naming ${r.issueKey} as plain text, with no tracker URL or Markdown link. This conversation is complete; their next message starts a new one. Do not promise dates or outcomes.`;
}

/** Tools every path has: start over. */
export const startOverHandler = (store: ConversationStore): ToolHandler => withSchema(startOverSchema, async () => {
  await store.startOver();
  return 'The conversation is discarded. Say in one short sentence that you have dropped it and that their next message starts fresh; ask nothing else.';
});

/** Handlers shared by the intake and problem agents. */
export function briefHandlers(ctx: AgentContext, store: ConversationStore): Record<string, ToolHandler> {
  const env = reportEnvironment(ctx);
  return {
    search_docs: searchDocsHandler(ctx),
    search_open_issues: searchOpenIssuesHandler(store),
    update_brief: withSchema(updateBriefSchema, async ({ section, text }) => {
      const brief = store.getBrief(); if (!brief) return err('There is no brief on this path.');
      const r = setTextSection(brief, section, text); if (!r.ok) return err(r.message);
      await store.setBrief(r.brief); return briefView(store);
    }),
    set_brief_choice: withSchema(setBriefChoiceSchema, async ({ section, choice }) => {
      const brief = store.getBrief(); if (!brief) return err('There is no brief on this path.');
      const r = setChoiceSection(brief, section, choice); if (!r.ok) return err(r.message);
      await store.setBrief(r.brief); return briefView(store);
    }),
    estimate_class: withSchema(estimateClassSchema, async ({ changeClass, reason }) => {
      const brief = store.getBrief(); if (!brief) return err('There is no brief on this path.');
      await store.setBrief(setEstimatedClass(brief, changeClass)); return `Estimated change class set to ${changeClass} (${reason}).`;
    }),
    propose_title: withSchema(proposeTitleSchema, async ({ title }) => {
      const v = validateTitle(title); if (!v.ok) return err(v.message);
      await store.setTitle(v.title); return `Title set: ${v.title}`;
    }),
    switch_path: withSchema(switchPathSchema, async ({ to }) => {
      if (store.getPath() === to) return err(`The conversation is already on the ${to} path.`);
      const next = withScreenArea(carryOver(store.getBrief(), to, env), ctx.screen);
      await store.setBrief(next); await store.setPath(to);
      return `Switched to the ${to} path. ${to === 'feature' ? 'Ask what the requester wants to happen instead, then continue the brief.' : 'Use what is already known; ask at most one essential clarification, then show a concise report for confirmation.'} Carried over:\n${next ? renderBriefMarkdown(next) : ''}`;
    }),
    add_me: withSchema(addMeSchema, async ({ issueId, notes }) => {
      const issue = ctx.openIssues.find((i) => i.id === issueId || i.key === issueId);
      if (!issue) return err(`No open issue with id "${issueId}". Use search_open_issues first.`);
      // Add me subscribes to a pipeline request; an issue created directly in the tracker has none to join.
      if (!issue.requestId) return err(`${issue.key} was not filed through this panel, so Add me is not available for it. Tell the requester it is tracked as ${issue.key} and continue with their own request.`);
      try { return filedResult(await store.addMe(issue.requestId, notes.trim()), 'Added the requester to'); } catch (error) { return err(`Add me failed: ${message(error)} Tell the requester and continue with their own request.`); }
    }),
    decline: withSchema(declineSchema, ({ reason }) => {
      store.decline(reason);
      return `Declined (${reason}). Tell the requester: "${DECLINE_MESSAGES[reason]}"${reason === 'abusive' ? ' This conversation is over.' : ' They can start over or stop here.'}`;
    }),
    request_file: withSchema(requestFileSchema, async () => {
      if (!ctx.filingAllowed) return err('Filing is not available for this account. Say so; nothing was filed.');
      const brief = store.getBrief();
      if (!completeness(brief).fileable) {
        const required = brief?.kind === 'problem' ? 'what happened or what they expected' : 'the Problem or the Desired behavior';
        return err(`Cannot file: ${DECLINE_MESSAGES.empty} Ask for ${required} instead of filing.`);
      }
      try { return filedResult(await store.fileRequest(), 'Filed'); } catch (error) { return err(`Filing failed: ${message(error)} Tell the requester in one sentence; the brief is kept and they can confirm again.`); }
    }),
    start_over: startOverHandler(store),
  };
}

/**
 * The tool list for a brief-gathering path. `request_file` appears once the brief has substance, filing is
 * allowed and the account is under its open-request limit; the prompt still requires the shown brief and an explicit yes.
 * The 30th message is still recorded (restricts the conversation after 30); the open-request limit counts the
 * account's own filings, not the requests it joined with Add me.
 */
export function briefTools(ctx: AgentContext): Anthropic.Tool[] {
  const atLimit = ctx.messageCount > ctx.limits.messagesPerConversation;
  const canFile = ctx.filingAllowed && ctx.openRequestCount < ctx.limits.openRequestsPerAccount && completeness(ctx.brief).fileable;
  if (atLimit) return canFile ? [requestFileTool, declineTool, startOverTool] : [declineTool, startOverTool];
  const tools = [searchDocsTool, searchOpenIssuesTool, updateBriefTool, setBriefChoiceTool, proposeTitleTool, switchPathTool, addMeTool, declineTool, startOverTool];
  return canFile ? [...tools, requestFileTool] : tools;
}

/* ---------- context and prompts ---------- */

export function hostName(ctx: AgentContext): string { return ctx.host.charAt(0).toUpperCase() + ctx.host.slice(1); }
/** Volatile facts for the first user message (never ask for these). */
export function contextBlock(ctx: AgentContext): string {
  const screen = `${ctx.screen.editor} editor${ctx.screen.documentType ? `, document type ${ctx.screen.documentType}` : ''}, ${ctx.screen.browser} on ${ctx.screen.os}`;
  // Titles are requester-authored: one line each, every framing tag defused, inside an <issue> frame.
  const line = (text: string) => defuseFraming(text.replace(/\s+/g, ' ').slice(0, 100));
  const own = ctx.openRequests.length ? ctx.openRequests.map((r) => `- ${r.issueKey} "${line(r.title)}" (${r.requesterState})`).join('\n') : '- none';
  const issues = ctx.openIssues.length ? ctx.openIssues.slice(0, 40).map((i) => `- ${i.key}: ${line(i.title)}`).join('\n') : '- none';
  const brief = ctx.brief ? `\n${frameRequesterText(renderBriefMarkdown(ctx.brief, ctx.title), 'brief')}` : '';
  return [
    '<context>', `host: ${ctx.host}`, `account_email: ${ctx.accountEmail}`, `roles: ${ctx.roles.join(', ') || 'user'}`, `filing_allowed: ${ctx.filingAllowed}`,
    `screen: ${screen}`, ...(ctx.document ? [`open_document: ${ctx.document.type}${ctx.document.type === 'layout' ? ' (the layout_* tools read and edit it)' : ' (UI guidance only)'}`] : []),
    `build: ${ctx.build.version} (${ctx.build.commit})`, `time: ${ctx.now}`, `path: ${ctx.path}`,
    `requester_messages_so_far: ${ctx.messageCount} of ${ctx.limits.messagesPerConversation}`,
    `open_requests_filed_by_this_account: ${ctx.openRequestCount} of ${ctx.limits.openRequestsPerAccount}`,
    'requests_listed_under_this_account (own and joined with Add me):', frameRequesterText(own, 'issue'),
    'open_issues_in_tracker (titles; use search_open_issues for details):', frameRequesterText(issues, 'issue'), '</context>', brief,
  ].join('\n');
}
/** The one opening question of the feature path. */
export function openingQuestion(ctx: AgentContext): string {
  return `What are you trying to do in ${hostName(ctx)} that you cannot do today, or that should work differently?`;
}
/** Rules shared by the feature path and, through the open agent, by a first turn whose path is not yet chosen. */
export const FEEDBACK_RULES = `Keep feedback intake short. Record the details already provided, including a clear expectation conveyed by the requester's own words; never ask them to repeat them. Ask at most one essential clarifying question across the filing conversation, only if needed to understand the problem or desired change. Then propose a concise title and summary and ask whether to send it. Frequency, impact, workaround and other optional fields are not an interview checklist; leave missing values unset. Use the known editor as the default Area without asking or confirming the workspace, preserving an explicitly different area. A vague answer or "I don't know" ends clarification; proceed with what you have. Do not turn a problem report into troubleshooting unless the requester asks for help. Omit empty fields and internal jargon from the chat review. Never show internal tracker URLs: use the plain issue key only. Filing still requires an explicit yes after the review.`;

export const COMMON_RULES = (ctx: AgentContext) => `You are the AI Chat assistant inside ${hostName(ctx)}. You talk with a signed-in requester through a side panel. Be brief, warm and concrete; plain sentences, no headings, no bullet lists longer than three items.

Rules that always apply:
${FEEDBACK_RULES}
- Filing creates an ordinary Linear ticket for the team to review. Never promise an automatic implementation, request branch, preview or delivery date. Historical build/trial fields do not enable automation.
- Ask one question at a time and wait for the answer. The requester may skip any question; then the section stays "Not provided". Never invent, infer or embellish a section; record only what the requester said or confirmed, through the tools.
- Never ask for anything in <context>: the account email, the document type, the build, the browser or the time.
- ${FRAMING_RULE}
- Keep the requester's wording when recording sections; tidy spelling only.
- Call search_open_issues once you know what the requester wants; when an open request matches, name its key and title in the chat and ask whether they want to be added to it. Only when their latest message says yes, call add_me and tell them which request you added them to; nothing new is filed and the conversation is complete. If they say no, continue.
- Sending the brief: once you have enough (at least Problem or Desired behavior, plus whatever else they gave) or the requester says they are done, show a concise summary of the provided details, omitting empty optional sections, set a title of at most 80 characters with propose_title and show it too, then ask whether to send it. The requester can still change any section and the title; show the updated brief each time. Call request_file only after you have shown the summary and title and the requester's latest message explicitly confirms sending it; never file on your own initiative or on a message that merely answers a question. When they say they are done but Problem and Desired behavior are both missing, say what is missing instead of filing.
- After request_file succeeds, report the issue key it returns and what happens next in your own words; the conversation is then complete.
- Decline with the decline tool, naming the reason, when the content is abusive, has nothing to do with the product, or when after asking the requester has given neither the problem nor the desired behavior.
- Starting over: when the requester clearly asks to start over or drop this request, call start_over; if anything substantial has been gathered, ask once whether they really want to drop it and call it only after a yes.
- Do not promise that anything will be built, scheduled or changed. Say what happens next: a maintainer reviews the request and the requester gets email updates at their account address.`;

export const LIMIT_RULES = (ctx: AgentContext) => {
  const parts: string[] = [];
  if (ctx.messageCount > ctx.limits.messagesPerConversation) parts.push(`This conversation has reached its ${ctx.limits.messagesPerConversation}-message limit. Do not ask further questions; only offer to send the brief as it stands (show it and ask for a yes, then request_file) or to stop (start_over).`);
  else if (ctx.messageCount === ctx.limits.messagesPerConversation) parts.push(`This is the requester's last message in this conversation (${ctx.limits.messagesPerConversation}-message limit). Record what they said, then say the limit is reached and that they can send the brief as it stands or stop; ask nothing further.`);
  if (ctx.openRequestCount >= ctx.limits.openRequestsPerAccount) parts.push(`The account has ${ctx.openRequestCount} open requests, the limit. Explain this, list the open requests from <context>, and offer Add me to a matching open request; do not offer a new filing.`);
  if (!ctx.filingAllowed) parts.push('Filing is not available for this account in this product. You can still help; say that filing is not available when asked.');
  return parts.length ? `\n\nCurrent limits:\n- ${parts.join('\n- ')}` : '';
};

export const FEATURE_SYSTEM = (ctx: AgentContext) => `${COMMON_RULES(ctx)}

You are on the feature path: the requester wants a new capability (Kind feature) or an existing one to work differently (Kind ux-change). Only when the requester selected the card without describing the issue, open with this question; otherwise use their description without asking it again: "${openingQuestion(ctx)}"

Record the problem and desired behavior already described, then show a concise title/summary for sending. Ask at most one essential clarification if the goal is unclear. Workaround, acceptance examples, must-not-change, importance and Area are not a required interview. Set Kind with set_brief_choice when clear; use the known editor for Area without confirmation.

Before gathering details, call search_docs: when the behavior already exists, say so, explain how to use it from the documentation, and ask whether the request still differs. If it does not, end the conversation without filing; nothing is recorded.

When the requester describes something that is specified or used to work but does not (a defect), first record everything they already told you into the brief with update_brief (problem, desired behavior, workaround), then say that it sounds like a problem report and ask whether to switch; after a yes call switch_path. Their recorded answers carry over to the new path; do not ask them again.${LIMIT_RULES(ctx)}`;

/** Feature and UX change intake. */
export const intakeAgent: ConversationAgent = {
  system: FEATURE_SYSTEM,
  context: contextBlock,
  tools: briefTools,
  handlers: briefHandlers,
};
