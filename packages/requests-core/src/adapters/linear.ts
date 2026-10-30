// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { TrackerConfig } from '../config/schema.ts';
import { headerOf, hmacSha256Hex, timingSafeEqualHex } from './signature.ts';
import { TrackerError, type Tracker, type TrackerActor, type TrackerEvent, type TrackerIssue, type TrackerIssueInput, type WebhookInput } from './tracker.ts';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
/** Payloads older (or newer) than this are rejected (replay protection). */
export const LINEAR_WEBHOOK_WINDOW_MS = 60_000;

export interface LinearTrackerOptions {
  token: string;
  tracker: TrackerConfig;
  webhookSecret?: string | undefined;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  endpoint?: string | undefined;
}
interface Team {
  id: string; key: string;
  states: Map<string, string>;
  labels: Map<string, string>;
  projects: Map<string, string>;
}
interface IssueNode {
  id: string; identifier: string; url: string; title: string; description: string | null;
  state: { name: string }; labels: { nodes: { name: string }[] };
}
const ISSUE_FIELDS = 'id identifier url title description state { name } labels { nodes { name } }';
// Linear scores nested connections by the parent page size, so the team connection is pinned to one node.
const TEAM_QUERY = `query Team($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) { nodes { id key
    states(first: 250) { nodes { id name type } }
    labels(first: 250) { nodes { id name } }
    projects(first: 250) { nodes { id name } } } }
  issueLabels(filter: { team: { null: true } }, first: 250) { nodes { id name } } }`;

function toIssue(node: IssueNode): TrackerIssue {
  return { id: node.id, key: node.identifier, url: node.url, title: node.title, state: node.state.name, labels: node.labels.nodes.map(l => l.name), body: node.description };
}
function actorOf(payload: { actor?: { id?: string; name?: string; email?: string; type?: string } | null }, fallback?: { id?: string; name?: string; email?: string } | null): TrackerActor {
  const a = payload.actor ?? fallback ?? null;
  const type = payload.actor?.type === 'user' ? 'user' : payload.actor?.type ? 'integration' : fallback ? 'user' : 'unknown';
  return { id: a?.id ?? null, name: a?.name ?? null, email: a?.email?.toLowerCase() ?? null, type };
}

/** Authorization header value: raw for personal API keys, bearer for OAuth tokens. */
export function linearAuthorization(token: string): string { return token.startsWith('lin_api_') ? token : `Bearer ${token}`; }

/** Linear GraphQL implementation of `Tracker`. */
export class LinearTracker implements Tracker {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly endpoint: string;
  private team: Promise<Team> | null = null;
  constructor(private readonly options: LinearTrackerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.endpoint = options.endpoint ?? LINEAR_GRAPHQL_URL;
  }

  /** One GraphQL round trip; maps transport, auth and rate-limit failures to `TrackerError`. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: linearAuthorization(this.options.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new TrackerError('unavailable', 'Could not reach Linear.', error);
    }
    if (response.status === 401 || response.status === 403) throw new TrackerError('auth', 'Linear rejected the credentials.');
    if (response.status === 429) throw new TrackerError('rate_limited', 'Linear is rate limiting requests.');
    const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message: string; extensions?: { type?: string; code?: string } }[] } | null;
    if (!response.ok && !body?.errors) throw new TrackerError('unavailable', `Linear returned ${response.status}.`);
    if (body?.errors?.length) {
      const first = body.errors[0]!;
      const kind = first.extensions?.type ?? first.extensions?.code ?? '';
      if (/auth/i.test(kind)) throw new TrackerError('auth', `Linear: ${first.message}`);
      if (/ratelimit/i.test(kind)) throw new TrackerError('rate_limited', `Linear: ${first.message}`);
      throw new TrackerError('invalid', `Linear: ${body.errors.map(e => e.message).join('; ')}`);
    }
    if (!body?.data) throw new TrackerError('unavailable', 'Linear returned no data.');
    return body.data;
  }

  private loadTeam(): Promise<Team> {
    this.team ??= this.graphql<{
      teams: { nodes: { id: string; key: string; states: { nodes: { id: string; name: string }[] }; labels: { nodes: { id: string; name: string }[] }; projects: { nodes: { id: string; name: string }[] } }[] };
      issueLabels: { nodes: { id: string; name: string }[] };
    }>(TEAM_QUERY, { key: this.options.tracker.team }).then(data => {
      const node = data.teams.nodes[0];
      if (!node) throw new TrackerError('invalid', `Linear team "${this.options.tracker.team}" was not found.`);
      const labels = new Map<string, string>();
      for (const l of [...data.issueLabels.nodes, ...node.labels.nodes]) labels.set(l.name.toLowerCase(), l.id);
      return {
        id: node.id, key: node.key,
        states: new Map(node.states.nodes.map(s => [s.name, s.id])),
        labels,
        projects: new Map(node.projects.nodes.map(p => [p.name, p.id])),
      };
    }).catch(error => { this.team = null; throw error; });
    return this.team;
  }
  private async projectId(kind: TrackerIssueInput['kind']): Promise<string> {
    const team = await this.loadTeam();
    const destination = this.options.tracker.problemDestination;
    const name = kind === 'problem' && !destination.sameProject && destination.project ? destination.project : this.options.tracker.project;
    const id = team.projects.get(name);
    if (!id) throw new TrackerError('invalid', `Linear project "${name}" was not found in team ${team.key}.`);
    return id;
  }
  private async stateId(name: string): Promise<string> {
    const team = await this.loadTeam();
    const id = team.states.get(name);
    if (!id) throw new TrackerError('invalid', `Linear state "${name}" does not exist in team ${team.key}.`);
    return id;
  }
  /** Label ids by name, creating team labels that do not exist yet. */
  private async labelIds(names: readonly string[]): Promise<string[]> {
    const team = await this.loadTeam();
    const ids: string[] = [];
    for (const name of names) {
      let id = team.labels.get(name.toLowerCase());
      if (!id) {
        const created = await this.graphql<{ issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string } } }>(
          'mutation CreateLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }',
          { input: { name, teamId: team.id } },
        );
        id = created.issueLabelCreate.issueLabel.id;
        team.labels.set(name.toLowerCase(), id);
      }
      ids.push(id);
    }
    return ids;
  }

  /** Server upload protocol: https://linear.app/developers/how-to-upload-a-file-to-linear */
  async uploadImage(name: string, mime: string, bytes: Blob): Promise<string> {
    const result = await this.graphql<{ fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } | null } }>(
      `mutation ImageUpload($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`, { contentType: mime, filename: name, size: bytes.size });
    const file = result.fileUpload.uploadFile;
    if (!result.fileUpload.success || !file) throw new TrackerError('unavailable', 'Linear could not prepare the image upload.');
    const headers = new Headers({ 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000' });
    for (const { key, value } of file.headers) headers.set(key, value);
    let response: Response;
    try { response = await this.fetchImpl(file.uploadUrl, { method: 'PUT', headers, body: bytes }); }
    catch { throw new TrackerError('unavailable', 'The image upload to Linear failed. Please retry.'); }
    if (!response.ok) throw new TrackerError('unavailable', `Linear image upload failed (${response.status}).`);
    return file.assetUrl;
  }
  async createIssue(input: TrackerIssueInput): Promise<TrackerIssue> {
    const team = await this.loadTeam();
    const [projectId, stateId, labelIds] = await Promise.all([this.projectId(input.kind), this.stateId(this.options.tracker.states.triage), this.labelIds(input.labels)]);
    const data = await this.graphql<{ issueCreate: { success: boolean; issue: IssueNode } }>(
      `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
      { input: { teamId: team.id, projectId, stateId, labelIds, title: input.title, description: input.body } },
    );
    if (!data.issueCreate.success) throw new TrackerError('invalid', 'Linear did not create the issue.');
    return toIssue(data.issueCreate.issue);
  }
  async addComment(issueId: string, body: string): Promise<{ id: string }> {
    const data = await this.graphql<{ commentCreate: { success: boolean; comment: { id: string } } }>(
      'mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
      { input: { issueId, body } },
    );
    if (!data.commentCreate.success) throw new TrackerError('invalid', 'Linear did not create the comment.');
    return { id: data.commentCreate.comment.id };
  }
  async setState(issueId: string, stateName: string): Promise<void> {
    const stateId = await this.stateId(stateName);
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      'mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
      { id: issueId, input: { stateId } },
    );
    if (!data.issueUpdate.success) throw new TrackerError('invalid', 'Linear did not update the issue state.');
  }
  async setLabels(issueId: string, labels: readonly string[]): Promise<void> {
    const labelIds = await this.labelIds(labels);
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      'mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
      { id: issueId, input: { labelIds } },
    );
    if (!data.issueUpdate.success) throw new TrackerError('invalid', 'Linear did not update the issue labels.');
  }
  async getIssue(issueId: string): Promise<TrackerIssue | null> {
    try {
      const data = await this.graphql<{ issue: IssueNode | null }>(`query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id: issueId });
      return data.issue ? toIssue(data.issue) : null;
    } catch (error) {
      if (error instanceof TrackerError && error.code === 'invalid' && /not found|Entity not found/i.test(error.message)) return null;
      throw error;
    }
  }
  async searchOpen(query: string): Promise<TrackerIssue[]> {
    const text = query.trim();
    const filter: Record<string, unknown> = {
      team: { key: { eq: this.options.tracker.team } },
      state: { type: { nin: ['completed', 'canceled'] } },
      ...(text ? { or: [{ title: { containsIgnoreCase: text } }, { description: { containsIgnoreCase: text } }] } : {}),
    };
    const data = await this.graphql<{ issues: { nodes: IssueNode[] } }>(
      `query OpenIssues($filter: IssueFilter!) { issues(filter: $filter, first: 25, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`,
      { filter },
    );
    return data.issues.nodes.map(toIssue);
  }
  async listStateNames(): Promise<string[]> { return [...(await this.loadTeam()).states.keys()]; }
  async listProjectNames(): Promise<string[]> { return [...(await this.loadTeam()).projects.keys()]; }

  /** `linear-signature` is the hex HMAC-SHA256 of the raw body; `webhookTimestamp` must be within 60 s. */
  async verifyWebhook({ body, headers }: WebhookInput): Promise<boolean> {
    const secret = this.options.webhookSecret;
    const signature = headerOf(headers, 'linear-signature');
    if (!secret || !signature) return false;
    if (!timingSafeEqualHex(signature, await hmacSha256Hex(secret, body))) return false;
    let timestamp: unknown;
    try { timestamp = (JSON.parse(body) as { webhookTimestamp?: unknown }).webhookTimestamp; } catch { return false; }
    return typeof timestamp === 'number' && Math.abs(this.now() - timestamp) <= LINEAR_WEBHOOK_WINDOW_MS;
  }
  parseWebhook(input: WebhookInput): TrackerEvent | null { return parseLinearWebhook(input)[0] ?? null; }
}

interface LinearPayload {
  action?: string; type?: string; createdAt?: string; webhookTimestamp?: number; webhookId?: string;
  actor?: { id?: string; name?: string; email?: string; type?: string } | null;
  updatedFrom?: Record<string, unknown> | null;
  data?: {
    id?: string; identifier?: string; body?: string; issueId?: string;
    state?: { name?: string } | null; labels?: { name?: string }[]; labelIds?: string[];
    issue?: { id?: string; identifier?: string } | null; user?: { id?: string; name?: string; email?: string } | null;
  };
}
/**
 * All pipeline events in one Linear webhook payload: an Issue update may change state and labels at
 * once, so this returns both; `LinearTracker.parseWebhook` returns the first for the `Tracker` contract.
 */
export function parseLinearWebhook({ body, headers }: WebhookInput): TrackerEvent[] {
  let payload: LinearPayload;
  try { payload = JSON.parse(body) as LinearPayload; } catch { return []; }
  const data = payload.data ?? {};
  const at = payload.createdAt ?? new Date(payload.webhookTimestamp ?? 0).toISOString();
  const delivery = headerOf(headers, 'linear-delivery') ?? `${payload.webhookId ?? 'linear'}:${payload.webhookTimestamp ?? ''}:${data.id ?? ''}`;
  if (payload.type === 'Comment' && payload.action === 'create' && data.id && data.issueId && typeof data.body === 'string') {
    return [{ kind: 'comment', issueId: data.issueId, issueKey: data.issue?.identifier ?? null, commentId: data.id, body: data.body, actor: actorOf(payload, data.user), deliveryId: delivery, at }];
  }
  if (payload.type === 'Issue' && payload.action === 'update' && data.id) {
    const from = payload.updatedFrom ?? {};
    const actor = actorOf(payload);
    const events: TrackerEvent[] = [];
    if ('stateId' in from && data.state?.name) {
      events.push({ kind: 'state', issueId: data.id, issueKey: data.identifier ?? null, stateName: data.state.name, previousStateName: null, actor, deliveryId: `${delivery}:state`, at });
    }
    if ('labelIds' in from && Array.isArray(data.labels)) {
      const labels = data.labels.map(l => l.name).filter((n): n is string => typeof n === 'string');
      events.push({ kind: 'label', issueId: data.id, issueKey: data.identifier ?? null, labels, previousLabels: null, actor, deliveryId: `${delivery}:label`, at });
    }
    return events;
  }
  return [];
}
