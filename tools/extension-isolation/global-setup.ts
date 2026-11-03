// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { startIsolationServers } from './server';

/** Starts the harness servers once for the run; their addresses reach the test workers through the environment. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const servers = await startIsolationServers();
  process.env.ISOLATION_HOSTED = servers.hosted;
  process.env.ISOLATION_ENFORCED = servers.enforced;
  process.env.ISOLATION_REMOTE = servers.remote;
  process.env.ISOLATION_STUN = servers.stun;
  return () => servers.close();
}
