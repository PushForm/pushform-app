// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommonsProfile, CommonsProfiles } from '@pushform/cloud';
import { ProfileHero, ProfileImagesEditor, type ProfileImageServices } from './ProfileImages';
import { CommonsProfileEditor } from './CommonsProfile';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', imageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const filesUrl = 'https://files.example.com';
const image = { id: imageId, width: 512, height: 512, sizeBytes: 1000, sha256: 'a'.repeat(64) };
const profile: CommonsProfile = { id, handle: 'example-maker', displayName: 'Example Maker', bio: '', avatarUrl: null, links: [], active: true, version: 3, avatarImage: null, bannerImage: null };
afterEach(cleanup);

function services(overrides: Partial<ProfileImageServices> = {}) {
  const release = vi.fn();
  const value = {
    filesUrl, token: vi.fn(async () => 'session-token'),
    load: vi.fn(async () => ({ image: {} as CanvasImageSource, size: { width: 3000, height: 1000 }, url: 'blob:source', release })),
    render: vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' })),
    upload: vi.fn(async (_base: string, _token: string, _kind: string, _blob: Blob, _signal: AbortSignal, options?: { onProgress?: (p: { stage: 'uploading'; loaded: number; total: number }) => void }) => {
      options?.onProgress?.({ stage: 'uploading', loaded: 1, total: 2 }); return { id: imageId };
    }),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
  return { value: value as unknown as ProfileImageServices, mocks: value, release };
}
const choose = (label: RegExp, file = new File(['x'], 'photo.png', { type: 'image/png' })) => fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });

it('crops a chosen avatar, previews it, uploads it with progress and refreshes the profile', async () => {
  const { value, mocks, release } = services(); const onChanged = vi.fn(async () => {});
  render(<ProfileImagesEditor profile={profile} services={value} onChanged={onChanged}/>);
  choose(/Upload profile picture/);
  const frame = await screen.findByRole('group', { name: /Crop profile picture/ });
  expect(screen.getByAltText('Profile picture preview, large')).toBeTruthy(); expect(screen.getByAltText('Profile picture preview, small')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Zoom'), { target: { value: '2' } });
  fireEvent.keyDown(frame, { key: 'ArrowRight' });
  fireEvent.click(screen.getByRole('button', { name: 'Save profile picture' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const crop = vi.mocked(mocks.render).mock.calls[0]![3] as unknown as { zoom: number; centerX: number };
  expect(vi.mocked(mocks.render).mock.calls[0]![2]).toBe('avatar'); expect(crop.zoom).toBe(2); expect(crop.centerX).toBeGreaterThan(1500);
  expect(mocks.upload).toHaveBeenCalledWith(filesUrl, 'session-token', 'avatar', expect.any(Blob), expect.any(AbortSignal), expect.objectContaining({ onProgress: expect.any(Function) }));
  expect(await screen.findByText('Profile picture saved.')).toBeTruthy(); expect(screen.queryByRole('group')).toBeNull(); expect(release).toHaveBeenCalled();
});

it('crops banners to the wide frame and reports upload failures without closing the cropper', async () => {
  const { value, mocks } = services({ upload: vi.fn(async () => { throw new Error('The image failed its size, type or checksum checks.'); }) as never });
  render(<ProfileImagesEditor profile={profile} services={value} onChanged={vi.fn()}/>);
  choose(/Upload banner/); await screen.findByRole('group', { name: /Crop banner/ });
  fireEvent.wheel(screen.getByRole('group', { name: /Crop banner/ }), { deltaY: -100 }); expect(Number((screen.getByLabelText('Zoom') as HTMLInputElement).value)).toBeCloseTo(1.1);
  expect(screen.getByAltText('Banner preview, narrow screen')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save banner' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The image failed its size, type or checksum checks.');
  expect(vi.mocked(mocks.render).mock.calls[0]![2]).toBe('banner'); expect(screen.getByRole('group', { name: /Crop banner/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('group')).toBeNull();
});

it('reports unreadable files and replaces or removes current images', async () => {
  const { value, mocks } = services({ load: vi.fn(async () => { throw new Error('Choose a PNG or JPEG image.'); }) as never });
  const onChanged = vi.fn(async () => {});
  render(<ProfileImagesEditor profile={{ ...profile, avatarImage: image, bannerImage: { ...image, width: 1500, height: 500 } }} services={value} onChanged={onChanged}/>);
  expect(screen.getByAltText('Your current profile picture').getAttribute('src')).toBe(`${filesUrl}/profile-images/${imageId}`);
  choose(/Replace banner/); expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Choose a PNG or JPEG image.');
  fireEvent.click(screen.getByRole('button', { name: 'Remove profile picture' }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(filesUrl, 'session-token', 'avatar', expect.any(AbortSignal)));
  expect(await screen.findByText('Profile picture removed.')).toBeTruthy(); expect(onChanged).toHaveBeenCalled();
});

it('keeps showing a pasted avatar address until an image is uploaded', () => {
  render(<ProfileImagesEditor profile={{ ...profile, avatarUrl: 'https://example.com/me.png' }} services={services().value} onChanged={vi.fn()}/>);
  expect(screen.getByAltText('Your current profile picture').getAttribute('src')).toBe('https://example.com/me.png');
  expect(screen.getByLabelText('Replace profile picture')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Remove profile picture' })).toBeNull();
});

it('shows the banner across the top with the uploaded picture taking precedence over a pasted address', () => {
  const view = render(<ProfileHero profile={{ ...profile, avatarUrl: 'https://example.com/me.png', avatarImage: image, bannerImage: { ...image, id, width: 1500, height: 500 } }} filesUrl={filesUrl}/>);
  expect(screen.getByAltText("Example Maker's banner").getAttribute('src')).toBe(`${filesUrl}/profile-images/${id}`);
  const avatar = screen.getByAltText("Example Maker's profile picture"); expect(avatar.getAttribute('src')).toBe(`${filesUrl}/profile-images/${imageId}`);
  fireEvent.error(avatar); expect(screen.getByAltText("Example Maker's profile picture").getAttribute('src')).toBe('https://example.com/me.png');
  view.rerender(<ProfileHero profile={profile} filesUrl={filesUrl}/>);
  expect(screen.queryByRole('img')).toBeNull(); expect(screen.getByRole('heading', { name: 'Example Maker' })).toBeTruthy();
});

it('offers images only for an existing profile and keeps a pasted avatar address when saving the form', async () => {
  const saved = { ...profile, avatarUrl: 'https://example.com/me.png' };
  const save = vi.fn().mockResolvedValue(saved);
  const mine = vi.fn().mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, avatarImage: image, version: 4 });
  const { value } = services();
  render(<CommonsProfileEditor profiles={{ mine, save } as unknown as CommonsProfiles} images={value}/>);
  await screen.findByRole('heading', { name: 'Profile picture' }); expect(screen.queryByLabelText(/Avatar URL/)).toBeNull();
  choose(/Replace profile picture/); await screen.findByRole('group');
  fireEvent.click(screen.getByRole('button', { name: 'Save profile picture' }));
  await waitFor(() => expect(screen.getByAltText('Your current profile picture').getAttribute('src')).toBe(`${filesUrl}/profile-images/${imageId}`));
  fireEvent.click(screen.getByRole('button', { name: 'Save public profile' }));
  // The form keeps its loaded version: image changes never cause an edit conflict.
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: 'https://example.com/me.png' }), 3, true));
  cleanup();
  render(<CommonsProfileEditor profiles={{ mine: vi.fn().mockResolvedValue(null) } as unknown as CommonsProfiles} images={value}/>);
  expect(await screen.findByText(/add a profile picture and a banner after you publish/)).toBeTruthy(); expect(screen.queryByRole('heading', { name: 'Profile picture' })).toBeNull();
});
