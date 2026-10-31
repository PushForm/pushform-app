# Third-party notices for the STEP reader

This crate wraps the STEP reader and B-rep kernel of **SolidCraft** (https://github.com/tangency-labs/solidcraft),
copyright the SolidCraft contributors, licensed under the MIT License or the Apache License 2.0 at your option.
PushForm carries a copy of that kernel under `crates/solidcraft`, taken from the commit named in its README and
adapted there. SolidCraft's kernel builds on the **truck** CAD crates (https://github.com/ricosjp/truck), copyright
RICOS Co. Ltd., licensed under the Apache License 2.0, including the patched copies kept under
`crates/solidcraft/vendor`, and on **cgmath**-derived code (`matext4cgmath`).

The compiled modules (`packages/io/wasm/pushform-step*.wasm`) and the desktop app therefore contain code under
those licenses. Their texts are in `crates/solidcraft`. PushForm's own code in this crate is GPL-3.0-or-later,
as the rest of PushForm.
