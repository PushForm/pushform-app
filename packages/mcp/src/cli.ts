// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
/**
 * `pushform-mcp --headless [file.pf]`: an MCP server on stdio over a headless model. There is
 * no mode that connects to a running app (the live bridge was dropped, PF-178), so the command refuses
 * to start without `--headless`. Logs go to stderr: stdout carries the protocol.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, nodeFiles } from './server';
import { HeadlessSession } from './session';

export const USAGE = 'Usage: pushform-mcp --headless [model.pf]';

export async function main(argv: readonly string[]): Promise<number> {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }
  const headless = args.indexOf('--headless');
  if (headless < 0) {
    process.stderr.write(`pushform-mcp: only --headless is available; it does not connect to a running app.\n${USAGE}\n`);
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
