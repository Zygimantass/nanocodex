# Shared Agents UI

GPUI owns the Agents list, conversation and text composer on Mac and the web.
Hosts own authentication, durable runtime connections, drafts, and platform
tools. The renderer receives display data, not credentials or network clients.
iPhone and iPad continue to use SwiftUI.

This standalone workspace pins GPUI separately from the SDK dependency graph.
Use Rust 1.97 or newer:

```sh
cargo build --locked --release --manifest-path crates/nanocodex-ui/Cargo.toml --bin nanocodex-ui
pnpm build:ui:web
```

The native executable accepts `--stdio`: one camelCase v1 snapshot per stdin
line; one JSON action per stdout line. Diagnostics go to stderr. EOF or closing
the window exits. See `Snapshot` and `Action` in `src/lib.rs` for the wire
contract. The host must reject stale actions after a selection/account change.
Browser hosts use the same contract through a same-origin iframe. Destroying
the iframe releases its GPUI instance; credentials never cross this boundary.

The shared conversation renders plain text, activity, pending messages, and a
multiline composer. Rich Markdown, attachments, voice, model settings, remote
screens, and schedules remain in the hosts' secondary Tools view. The browser
also offers that HTML view through a keyboard-focusable accessibility shortcut;
the GPUI canvas does not replace its screen-reader semantics.

`pnpm build:ui:web` emits content-addressed JS/WASM under the ignored
`js/account/public/gpui/` directory. Account development and production builds
invoke it automatically. Rustup is required; the script installs the pinned
toolchain and wasm-bindgen CLI if missing. This is a single-threaded WASM build
and requires no cross-origin isolation headers.

After the normal workspace build, run a synthetic preview or the browser journey:

```sh
pnpm --filter nanocodex-web preview:ui
CHROME_PATH=/path/to/chrome pnpm --filter nanocodex-web test:ui
```

The preview uses production React, GPUI, and the managed HTTP SDK with synthetic
accounts and responses. It never forwards requests to real services. Evidence
is written under `output/gpui/`. Home and Account are placeholders in this
preview only. The application retains its existing Home and Account screens.

`src/input.rs` adapts the Apache-2.0 GPUI input example from the pinned revision,
with multiline layout, grapheme-aware edits and UTF-16 IME handling. The bundled
IBM Plex Sans files are from that revision's `assets/fonts/ibm-plex-sans`; their
SIL Open Font License is included alongside the fonts.
