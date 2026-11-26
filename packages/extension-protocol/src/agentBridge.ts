// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { z } from 'zod';
import {
  MODEL_TOOLS, modelBatchToolSchema, modelBuilderInfoSchema, modelGetDocumentSchema, modelMaterialLibrarySchema, modelOverlapsSchema,
  modelQuerySchema, modelRenderSchema, modelViewSchema,
} from './model.ts';

/**
 * The live agent bridge: an external agent (an MCP client such as Claude Code or Claude Desktop) edits the model open in
 * a running PushForm, so the requester watches each change land in their own viewport.
 *
 * `pushform-mcp --live` listens on a loopback WebSocket. A browser cannot listen on a port, so the app connects to it,
 * proves it was given the pairing code with `hello`, and then answers `call` messages by running the same model
 * document API AI Chat uses on the active model tab. Nothing passes through a backend.
 */
export const AGENT_BRIDGE_VERSION = 1;
/** The loopback port `pushform-mcp --live` listens on unless told otherwise, and the app's default. */
export const AGENT_BRIDGE_DEFAULT_PORT = 47615;
/** The undo entries and change notices of an external agent's batches name it with this. */
export const AGENT_BRIDGE_CLIENT = 'External agent';

/** The tools the bridge offers, in the order an agent should meet them: the model document API, as AI Chat has it. */
export const AGENT_BRIDGE_TOOLS: readonly { readonly name: string; readonly description: string; readonly schema: z.ZodObject }[] = [
  { name: MODEL_TOOLS.getDocument.name, description: MODEL_TOOLS.getDocument.description, schema: modelGetDocumentSchema },
  { name: MODEL_TOOLS.query.name, description: MODEL_TOOLS.query.description, schema: modelQuerySchema },
  { name: MODEL_TOOLS.applyOperations.name, description: MODEL_TOOLS.applyOperations.description, schema: modelBatchToolSchema },
  { name: MODEL_TOOLS.view.name, description: MODEL_TOOLS.view.description, schema: modelViewSchema },
  { name: MODEL_TOOLS.render.name, description: MODEL_TOOLS.render.description, schema: modelRenderSchema },
  { name: MODEL_TOOLS.overlaps.name, description: MODEL_TOOLS.overlaps.description, schema: modelOverlapsSchema },
  { name: MODEL_TOOLS.materialLibrary.name, description: MODEL_TOOLS.materialLibrary.description, schema: modelMaterialLibrarySchema },
  // A getter: the builder list is read when the tools are listed, not when this module loads.
  { name: MODEL_TOOLS.builderInfo.name, get description() { return MODEL_TOOLS.builderInfo.description; }, schema: modelBuilderInfoSchema },
];
export const AGENT_BRIDGE_TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_BRIDGE_TOOLS.map(tool => tool.name));

/** What the app has open, as the agent is told: null when the active tab is not a 3D model (Home, a Layout document). */
export const agentBridgeDocumentSchema = z.object({ name: z.string(), revision: z.number().int() }).nullable();
export type AgentBridgeDocument = z.infer<typeof agentBridgeDocumentSchema>;

const image = z.object({ mime: z.enum(['image/jpeg', 'image/png']), data: z.string() });

/** App → server. `hello` comes first and alone; anything before a `welcome` closes the connection. */
export const agentBridgeAppMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.number().int(), code: z.string().max(64), app: z.string().max(200), document: agentBridgeDocumentSchema }),
  z.object({ type: z.literal('document'), document: agentBridgeDocumentSchema }),
  z.object({ type: z.literal('result'), id: z.number().int(), content: z.string(), isError: z.boolean(), notice: z.string().optional(), images: z.array(image).max(3).optional() }),
]);
export type AgentBridgeAppMessage = z.infer<typeof agentBridgeAppMessageSchema>;

/** Server → app. */
export const agentBridgeServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), version: z.number().int(), agent: z.string() }),
  z.object({ type: z.literal('call'), id: z.number().int(), name: z.string(), input: z.unknown() }),
]);
export type AgentBridgeServerMessage = z.infer<typeof agentBridgeServerMessageSchema>;

/** WebSocket close codes the bridge uses, so the app can say why it was disconnected. */
export const AGENT_BRIDGE_CLOSE = {
  /** The pairing code did not match. */
  badCode: 4001,
  /** The app speaks another bridge version. */
  version: 4002,
  /** Another PushForm window paired, and took over. */
  replaced: 4003,
  /** A message was malformed or out of order. */
  protocol: 4004,
} as const;
