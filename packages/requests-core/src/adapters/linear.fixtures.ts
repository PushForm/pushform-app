// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * Recorded Linear GraphQL responses and webhook payloads, trimmed to the fields the adapter reads.
 * Ids are stable fakes so the tests can assert on them.
 */
export const TEAM_RESPONSE = {
  data: {
    teams: {
      nodes: [{
        id: 'team-frq', key: 'FRQ',
        states: { nodes: [
          { id: 'st-triage', name: 'Triage', type: 'triage' }, { id: 'st-backlog', name: 'Backlog', type: 'backlog' }, { id: 'st-build', name: 'Build', type: 'unstarted' },
          { id: 'st-design', name: 'Design review', type: 'started' }, { id: 'st-progress', name: 'In Progress', type: 'started' }, { id: 'st-trial', name: 'In Trial', type: 'started' },
          { id: 'st-human', name: 'Needs Human', type: 'started' }, { id: 'st-review', name: 'Ready for Review', type: 'started' }, { id: 'st-done', name: 'Done', type: 'completed' },
          { id: 'st-canceled', name: 'Canceled', type: 'canceled' },
        ] },
        labels: { nodes: [{ id: 'lb-feature', name: 'feature' }, { id: 'lb-defect', name: 'defect' }, { id: 'lb-source', name: 'source:in-app' }] },
        projects: { nodes: [{ id: 'pr-customer', name: 'Customer Features' }, { id: 'pr-defects', name: 'Defects' }] },
      }],
    },
    issueLabels: { nodes: [{ id: 'lb-ux', name: 'ux-change' }] },
  },
};
export const LABEL_CREATE_RESPONSE = (name: string, id: string) => ({ data: { issueLabelCreate: { success: true, issueLabel: { id, name } } } });
export const ISSUE_NODE = {
  id: 'iss-1', identifier: 'FRQ-123', url: 'https://linear.app/pushform/issue/FRQ-123/layout-move-tool', title: 'Layout: move tool',
  description: '## Kind\n\nFeature', state: { name: 'Triage' }, labels: { nodes: [{ name: 'feature' }, { name: 'area:layout' }, { name: 'source:in-app' }, { name: 'class:C3' }, { name: 'eligible:gated' }] },
};
export const ISSUE_CREATE_RESPONSE = { data: { issueCreate: { success: true, issue: ISSUE_NODE } } };
export const COMMENT_CREATE_RESPONSE = { data: { commentCreate: { success: true, comment: { id: 'cmt-1' } } } };
export const ISSUE_UPDATE_RESPONSE = { data: { issueUpdate: { success: true } } };
export const ISSUE_GET_RESPONSE = { data: { issue: ISSUE_NODE } };
export const ISSUE_GET_NOT_FOUND = { errors: [{ message: 'Entity not found: Issue - Could not find referenced Issue.', extensions: { type: 'invalid input', code: 'INVALID_INPUT' } }] };
export const ISSUES_SEARCH_RESPONSE = { data: { issues: { nodes: [ISSUE_NODE, { ...ISSUE_NODE, id: 'iss-2', identifier: 'FRQ-124', title: 'Layout: rotate tool', state: { name: 'Build' } }] } } };
export const AUTH_ERROR_RESPONSE = { errors: [{ message: 'Authentication required, not authenticated', extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' } }] };

export const WEBHOOK_SECRET = 'whsec_test_1234567890';
export const WEBHOOK_AT = 1_761_216_000_000; // 2026-10-23T10:40:00.000Z
export const ISSUE_STATE_WEBHOOK = {
  action: 'update', type: 'Issue', createdAt: '2026-10-23T10:40:00.000Z', organizationId: 'org-1', webhookTimestamp: WEBHOOK_AT, webhookId: 'wh-1',
  actor: { id: 'usr-maint', name: 'Maintainer', email: 'Testers@pushform.io', type: 'user' },
  url: 'https://linear.app/pushform/issue/FRQ-123/layout-move-tool',
  data: {
    id: 'iss-1', identifier: 'FRQ-123', title: 'Layout: move tool', stateId: 'st-canceled', state: { id: 'st-canceled', name: 'Canceled', type: 'canceled' },
    labelIds: ['lb-feature'], labels: [{ id: 'lb-feature', name: 'feature' }], team: { id: 'team-frq', key: 'FRQ' },
  },
  updatedFrom: { stateId: 'st-triage', updatedAt: '2026-10-23T10:39:00.000Z' },
};
export const ISSUE_LABEL_WEBHOOK = {
  ...ISSUE_STATE_WEBHOOK,
  data: { ...ISSUE_STATE_WEBHOOK.data, stateId: 'st-triage', state: { id: 'st-triage', name: 'Triage', type: 'triage' }, labelIds: ['lb-feature', 'lb-c5'], labels: [{ id: 'lb-feature', name: 'feature' }, { id: 'lb-c5', name: 'class:C5' }, { id: 'lb-e', name: 'eligible:gated' }] },
  updatedFrom: { labelIds: ['lb-feature', 'lb-c3'], updatedAt: '2026-10-23T10:39:00.000Z' },
};
export const ISSUE_STATE_AND_LABEL_WEBHOOK = { ...ISSUE_LABEL_WEBHOOK, updatedFrom: { stateId: 'st-build', labelIds: ['lb-feature'], updatedAt: '2026-10-23T10:39:00.000Z' } };
export const ISSUE_TITLE_WEBHOOK = { ...ISSUE_STATE_WEBHOOK, updatedFrom: { title: 'Old title', updatedAt: '2026-10-23T10:39:00.000Z' } };
export const COMMENT_WEBHOOK = {
  action: 'create', type: 'Comment', createdAt: '2026-10-23T10:41:00.000Z', organizationId: 'org-1', webhookTimestamp: WEBHOOK_AT + 60_000, webhookId: 'wh-1',
  actor: { id: 'usr-maint', name: 'Maintainer', email: 'testers@pushform.io', type: 'user' },
  url: 'https://linear.app/pushform/issue/FRQ-123/layout-move-tool#comment-cmt-9',
  data: {
    id: 'cmt-9', body: 'Requester:\nCould you tell us which browser you used?', issueId: 'iss-1',
    issue: { id: 'iss-1', title: 'Layout: move tool', identifier: 'FRQ-123' }, user: { id: 'usr-maint', name: 'Maintainer', email: 'testers@pushform.io' },
  },
};
export const COMMENT_WEBHOOK_WITHOUT_ACTOR = { ...COMMENT_WEBHOOK, actor: undefined, data: { ...COMMENT_WEBHOOK.data, id: 'cmt-10', body: 'Internal note' } };
