// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * `pushform-mcp --headless [file.pf]`: an MCP server on stdio over a headless model.
 * `pushform-mcp --live [--port N] [--code CODE]`: an MCP server on stdio that edits the model open in a running
 * PushForm window, which connects to it over a loopback WebSocket (see live.ts). Logs go to stderr: stdout carries the protocol.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AGENT_BRIDGE_DEFAULT_PORT } from '@pushform/extension-protocol';
import { LiveBridge, createLiveMcpServer, normalizeCode, pairingSteps } from './live';
import { createMcpServer, nodeFiles } from './server';
import { HeadlessSession } from './session';

export const USAGE = `Usage: pushform-mcp --headless [model.pf]
       pushform-mcp --live [--port N] [--code CODE]   (port ${AGENT_BRIDGE_DEFAULT_PORT} by default; CODE also from PUSHFORM_AGENT_CODE)`;

/** `--live`: serve the paired app's model until the client closes stdin. */
async function live(args: string[]): Promise<number> {
  let port = AGENT_BRIDGE_DEFAULT_PORT;
  let code = process.env['PUSHFORM_AGENT_CODE'] || undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[i + 1];
    if (flag === '--port' && value !== undefined && /^\d+$/.test(value) && Number(value) < 65536) { port = Number(value); i++; }
    else if (flag === '--code' && value !== undefined && normalizeCode(value).length >= 6) { code = value; i++; }
    else {
      process.stderr.write(`pushform-mcp: unexpected argument ${flag}${flag === '--code' ? ' (a code needs at least 6 letters or digits)' : ''}\n${USAGE}\n`);
      return 2;
    }
  }
  const log = (line: string): void => void process.stderr.write(`pushform-mcp: ${line}\n`);
  const bridge = new LiveBridge({ port, code, log });
  try {
    await bridge.start();
  } catch (e) {
    log(`cannot listen on 127.0.0.1:${port}: ${e instanceof Error ? e.message : String(e)}. Is another pushform-mcp --live running? Use --port to pick another port.`);
    return 1;
  }
  const server = createLiveMcpServer(bridge);
  server.onerror = (e) => log(e instanceof Error ? (e.stack ?? e.message) : String(e));
  await server.connect(new StdioServerTransport());
  log(`waiting for PushForm on ws://127.0.0.1:${bridge.port}. ${pairingSteps(bridge.status())}`);
  return new Promise<number>((resolve) => {
    server.onclose = () => void bridge.close().then(() => resolve(0));
    process.stdin.once('end', () => void server.close());
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }
  const liveFlag = args.indexOf('--live');
  if (liveFlag >= 0) {
    args.splice(liveFlag, 1);
    return live(args);
  }
  const headless = args.indexOf('--headless');
  if (headless < 0) {
    process.stderr.write(`pushform-mcp: choose --headless (a model of its own) or --live (the model open in PushForm).\n${USAGE}\n`);
    return 2;
  }
  args.splice(headless, 1);
  const unknown = args.filter((a) => a.startsWith('-'));
  if (unknown.length || args.length > 1) {
    process.stderr.write(`pushform-mcp: unexpected arguments ${[...unknown, ...args.slice(1)].join(' ')}\n${USAGE}\n`);
    return 2;
  }
  const session = new HeadlessSession();
  const file = args[0];
  if (file) {
    try {
      await session.load(await nodeFiles.read(file), file);
    } catch (e) {
      process.stderr.write(`pushform-mcp: cannot open ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
      session.dispose();
      return 1;
    }
  }
  const server = createMcpServer(session);
  server.onerror = (e) => process.stderr.write(`pushform-mcp: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`pushform-mcp: serving ${file ?? 'a new model'} on stdio\n`);
  return new Promise<number>((resolve) => {
    server.onclose = () => {
      session.dispose();
      resolve(0);
    };
    // the client closing our stdin ends the session
    process.stdin.once('end', () => void server.close());
  });
}
