// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { createClient, type Session } from '@supabase/supabase-js';
import { ExtensionError } from '@pushform/extension-protocol';
import type { Database } from './db.types';
import type { BrowserCloudConfig } from './cloudConfig';
import { CloudExtensionAssets } from './CloudExtensionAssets';
import { CloudExtensionSettings } from './CloudExtensionSettings';

export interface CloudExtensionStorage { assets: CloudExtensionAssets; settings: CloudExtensionSettings }

/** Each HTTP request captures a token for exactly this workspace owner. A later SDK account switch cannot route
 * an old extension's pending operation into the new account, even while the old workspace is unmounting. */
export function accountExtensionStorage(config: BrowserCloudConfig, ownerId: string,
  session: () => Promise<Pick<Session,'user'|'access_token'> | null>, fetcher?: typeof fetch): CloudExtensionStorage {
  const client = createClient<Database>(config.url,config.publishableKey,{
    accessToken:async () => {
      const current = await session();
      if (!current || current.user.id !== ownerId) throw new ExtensionError('unavailable','This extension account session has ended.');
      return current.access_token;
    },
    ...(fetcher ? { global:{ fetch:fetcher } } : {}),
  });
  return { assets:new CloudExtensionAssets(client,fetcher),settings:new CloudExtensionSettings(client) };
}
