// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { accountExtensionStorage } from './CloudExtensionStorage';

it('pins each outgoing token to the workspace owner through account switches and sign-out', async () => {
  let current: { user: User; access_token: string } | null = { user:{ id:'alice' } as User,access_token:'alice-token' };
  const sent: string[] = [];
  const storage = (owner: string) => accountExtensionStorage({ url:'http://127.0.0.1:55321',publishableKey:'sb_publishable_test' },owner,async () => current,
    async (_url,init) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json({ entries:[],next:null });
    });
  const alice = storage('alice');
  await alice.assets.list('io.example.plugin',null,100);
  expect(sent).toEqual(['Bearer alice-token']);
  current = { user:{ id:'bob' } as User,access_token:'bob-token' };
  await expect(alice.assets.list('io.example.plugin',null,100)).rejects.toMatchObject({ code:'unavailable' });
  expect(sent).toHaveLength(1);
  const bob = storage('bob');
  await bob.assets.list('io.example.plugin',null,100);
  expect(sent).toEqual(['Bearer alice-token','Bearer bob-token']);
  current = null;
  await expect(bob.settings.save('io.example.plugin',1,{},null)).rejects.toThrow();
  expect(sent).toHaveLength(2);
});
