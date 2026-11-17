// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 PushForm contributors
import { setDocumentAutoFreeze } from '@pushform/model';

// Deep-freezing every record a commit writes costs more than the edit itself on large bodies. Development builds keep
// it, so a stray mutation of committed state still throws there.
if (import.meta.env.PROD) setDocumentAutoFreeze(false);
