# Third-party notices for the STEP reader

This crate wraps the STEP reader and B-rep kernel of **SolidCraft** (https://github.com/tangency-labs/solidcraft),
copyright the SolidCraft contributors, licensed under the MIT License or the Apache License 2.0 at your option,
pinned to the commit named in `Cargo.toml`. SolidCraft's kernel builds on the **truck** CAD crates
(https://github.com/ricosjp/truck), copyright RICOS Co. Ltd., licensed under the Apache License 2.0, including
the patched copies SolidCraft keeps under its `vendor/` directory, and on **cgmath**-derived code (`matext4cgmath`).

The compiled module (`packages/io/wasm/pushform-step.wasm`) therefore contains code under those licenses.
Their texts are available at the repositories above. PushForm's own code in this crate is GPL-3.0-or-later,
as the rest of PushForm.
