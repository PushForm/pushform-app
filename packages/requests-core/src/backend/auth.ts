// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import type { Config } from '../config/schema.ts';
import { DbError, meFromRow, type MeView, type ServiceDb, type UserDb } from './db.ts';

/** The verified session: Supabase `auth.getUser(token)` reduced to what the backend uses. */
export interface SessionUser { id: string; email: string }
export interface SessionValidator { getUser(token: string): Promise<SessionUser | null> }

/** HTTP error codes of the fr-conversation contract plus `unavailable` for a database that cannot be reached. */
export type HttpErrorCode = 'unauthorized' | 'forbidden' | 'not_found' | 'invalid' | 'rate_limited' | 'limit' | 'tracker_unavailable' | 'config_invalid' | 'unavailable' | 'not_implemented';
const STATUS: Record<HttpErrorCode, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, invalid: 400, rate_limited: 429, limit: 409, tracker_unavailable: 502, config_invalid: 500,
  unavailable: 503, not_implemented: 501,
};
export class HttpError extends Error {
  readonly status: number;
  constructor(readonly code: HttpErrorCode, message: string, readonly details?: unknown) { super(message); this.name = 'HttpError'; this.status = STATUS[code]; }
}
/** A `DbError` becomes the matching HTTP error; `forbidden` on lookups of own rows reads as not found so ids are not probed. */
export function httpErrorOf(error: unknown, forbiddenAs: 'forbidden' | 'not_found' = 'forbidden'): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof DbError) {
    switch (error.code) {
      case 'auth': return new HttpError('unauthorized', 'Sign in to continue.');
      case 'forbidden': return new HttpError(forbiddenAs, forbiddenAs === 'not_found' ? 'Not found.' : 'Not allowed.');
      case 'invalid': return new HttpError('invalid', 'The request is invalid.');
      case 'limit': return new HttpError('limit', 'A limit was reached.');
      case 'duplicate': return new HttpError('invalid', 'Already recorded.');
      case 'unavailable': return new HttpError('unavailable', 'The service is unavailable. Try again shortly.');
    }
  }
  return new HttpError('unavailable', 'The service is unavailable. Try again shortly.');
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-fr-client',
  'Access-Control-Max-Age': '86400',
};
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...headers } });
}
export const RATE_LIMITED_HEADERS: Record<string, string> = { 'Retry-After': '60' };
export function errorResponse(error: unknown): Response {
  const e = httpErrorOf(error);
  return json({ error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }, e.status, e.code === 'rate_limited' ? RATE_LIMITED_HEADERS : {});
}

/** `Authorization: Bearer <token>`; null when absent or malformed. */
export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m?.[1] ?? null;
}
/** Validate the session JWT through the injected validator (`createClient(url, serviceRoleKey).auth.getUser(token)` in Deno). */
export async function validateSession(req: Request, validator: SessionValidator): Promise<SessionUser> {
  const token = bearerToken(req);
  if (!token) throw new HttpError('unauthorized', 'Sign in to continue.');
  let user: SessionUser | null;
  try { user = await validator.getUser(token); } catch { throw new HttpError('unauthorized', 'The session could not be verified.'); }
  if (!user?.id || !user.email) throw new HttpError('unauthorized', 'The session is invalid or expired.');
  return { id: user.id, email: user.email.trim().toLowerCase() };
}
/** Roles and switches of the account through the user-scoped RPC; limits come from the config. */
export async function lookupRoles(userDb: UserDb, config: Config): Promise<MeView> {
  try { return meFromRow(await userDb.myRoles(config.host), config); } catch (error) { throw httpErrorOf(error); }
}
/** Shared secret check for the sweeper and job endpoints (`Authorization: Bearer <FR_JOBS_SECRET>`), constant time. */
export function hasJobsSecret(req: Request, secret: string): boolean {
  const token = bearerToken(req);
  if (!token || !secret) return false;
  const a = new TextEncoder().encode(token), b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
/** One `fr_rate_check` per requester message; over the limit answers 429 with `Retry-After: 60`. */
export async function enforceRate(db: ServiceDb, ownerId: string, limit: number): Promise<void> {
  let ok: boolean;
  try { ok = await db.rateCheck(ownerId, limit); } catch (error) { throw httpErrorOf(error); }
  if (!ok) throw new HttpError('rate_limited', `You are sending messages too quickly; the limit is ${limit} per minute. Wait a moment and try again.`);
}
