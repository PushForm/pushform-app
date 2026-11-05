// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { PublishSnapshot } from './PublishSnapshot';
import type { PublishingSnapshot } from './SaveVersionDialog';
import type { CommonsAccount } from '@pushform/commons-ui/account';
import { modelPicture } from '../modelPicture';
const received = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@pushform/commons-ui', () => ({ UploadDialog: (props: Record<string, unknown>) => { received.props = props; return <div>Ready to share</div>; } }));
vi.mock('@pushform/io', () => ({ openModelFile: async () => ({ state: { meta: {}, images: new Map() }, images: new Map() }) }));
vi.mock('../modelPicture', () => ({ modelPicture: vi.fn(async () => ({ toBlob: (done: (value: Blob) => void) => done(new Blob(['png'], { type: 'image/png' })) })) }));
vi.mock('@pushform/cloud', async original => ({ ...(await original<Record<string, unknown>>()), CommonsPublishing: class { async mine() { return { models: [] }; } } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); received.props = null; });
it('renders the saved revision using the captured camera, aspect and studio lighting without fitting a new view', async () => {
  const camera = { eye: [3,-4,2], target: [1,2,1], up: [.1,0,.995], fov: 42, projection: 'perspective', orthoHeight: 3 };
  const snapshot = { file: { id: 'file', name: 'cabinet.pf', revision_number: 12 }, bytes: new Uint8Array([1,2,3]), view: { camera, width: 1200, height: 700 } } as unknown as PublishingSnapshot;
  render(<PublishSnapshot account={{ client: {} } as CommonsAccount} filesUrl="https://files.example.com" snapshot={snapshot} onClose={vi.fn()} />);
  await waitFor(() => expect(received.props?.initialImage).toBeInstanceOf(File));
  expect(modelPicture).toHaveBeenCalledWith(expect.anything(), expect.anything(), { camera, width: 1200, height: 700, lighting: 'bright', background: '#eef0e8' });
  expect((received.props!.initialImage as File).name).toBe('current-view.png');
  expect((received.props!.initialFile as File).size).toBe(3);
  expect(camera.up).toEqual([.1,0,.995]);
});
