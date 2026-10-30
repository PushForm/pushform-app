// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { config } from 'zod';

// zod compiles object parsers with `new Function` after probing whether it may. The Content-Security-Policy does not
// allow eval, so the probe would be reported on every load and then fall back anyway; skip it. Imported
// first by main.tsx, before any schema parses.
config({ jitless: true });
