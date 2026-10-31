// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors

// Vite's `?url` imports: the bundled file's URL.
declare module '*?url' {
  const url: string;
  export default url;
}
