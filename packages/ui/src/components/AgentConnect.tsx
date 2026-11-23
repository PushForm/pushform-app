// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { useState, useSyncExternalStore } from 'react';
import type { FormEvent, JSX } from 'react';
import type { AgentBridgeConnection } from '../agentBridge';

/**
 * The status bar's "Connect agent" control: pairs this window with `pushform-mcp --live`, then shows that an external
 * agent is connected, so its changes appearing in the model never come as a surprise.
 */
export function AgentConnect({ bridge }: { bridge: AgentBridgeConnection }): JSX.Element {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState(() => String(bridge.lastSettings.port));
  const [code, setCode] = useState(() => bridge.lastSettings.code);
  const label = state.status === 'connected' ? 'Agent connected' : state.status === 'connecting' ? 'Waiting for agent…' : 'Connect agent';
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535 || !code.trim()) return;
    bridge.connect({ port: number, code: code.trim() });
  };
  return (
    <div className={`pf-agent-connect is-${state.status}`}>
      <button type="button" className="pf-agent-connect-trigger" aria-expanded={open} onClick={() => setOpen(value => !value)}
        title={state.status === 'connected' ? `An external agent can edit the open 3D model (port ${state.port})` : 'Let an AI agent on this computer edit the open 3D model'}>
        <span className="pf-agent-connect-dot" aria-hidden="true" />
        <span role="status">{label}</span>
      </button>
      {open ? (
        <div className="pf-agent-connect-panel" role="dialog" aria-label="Connect agent">
          {state.status === 'connected' ? <>
            <p>An external agent is connected on port {state.port}. It edits the active 3D model tab, and each change is one Undo step named “External agent”.</p>
            <div className="pf-save-status-actions">
              <button type="button" className="pf-dialog-btn" onClick={() => bridge.disconnect()}>Disconnect</button>
            </div>
          </> : <form onSubmit={submit}>
            <p>Start <code>pushform-mcp --live</code> from your agent (Claude Code or Claude Desktop), then enter the port and pairing code it gives you.</p>
            <label className="pf-agent-connect-field">Port
              <input className="pf-dialog-input" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
            </label>
            <label className="pf-agent-connect-field">Pairing code
              <input className="pf-dialog-input" autoComplete="off" spellCheck={false} placeholder="K7QM-4XRT" value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            {state.status === 'off' && state.error ? <p role="alert">{state.error}</p> : null}
            {state.status === 'connecting' ? <p>Waiting for the agent on port {state.port}. It connects as soon as the agent is running.</p> : null}
            <div className="pf-save-status-actions">
              {state.status === 'connecting' ? <button type="button" className="pf-dialog-btn" onClick={() => bridge.disconnect()}>Stop</button> : null}
              <button type="submit" className="pf-dialog-btn is-primary">Connect</button>
            </div>
          </form>}
        </div>
      ) : null}
    </div>
  );
}
