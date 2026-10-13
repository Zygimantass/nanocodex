#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$root/crates/nanocodex-ui/Cargo.toml"
target="${CARGO_TARGET_DIR:-$root/crates/nanocodex-ui/target}"
if [[ "$target" != /* ]]; then target="$root/$target"; fi
output="$root/js/account/public/gpui"
profile="${NANOCODEX_UI_PROFILE:-release}"
args=()
if [[ "$profile" == release ]]; then args+=(--release); elif [[ "$profile" != debug ]]; then echo 'NANOCODEX_UI_PROFILE must be debug or release' >&2; exit 1; fi
command -v rustup >/dev/null || { echo 'Install Rust with rustup and add ~/.cargo/bin to PATH.' >&2; exit 1; }
# SDK output-cache hits may skip the CI toolchain setup. GPUI has its own
# dependency graph and must also build correctly on those runners.
if ! rustup run 1.97 rustc --version >/dev/null 2>&1; then rustup toolchain install 1.97 --profile minimal; fi
if [[ "$(wasm-bindgen --version 2>/dev/null || true)" != 'wasm-bindgen 0.2.126' ]]; then
  cargo +1.97 install --locked wasm-bindgen-cli --version 0.2.126
fi
rustup target add wasm32-unknown-unknown --toolchain 1.97
CARGO_TARGET_DIR="$target" cargo +1.97 build --manifest-path "$manifest" --locked --target wasm32-unknown-unknown --lib "${args[@]}"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
wasm-bindgen "$target/wasm32-unknown-unknown/$profile/nanocodex_ui.wasm" --target web --out-dir "$staging" --out-name nanocodex_ui
hash="$(cat "$staging/nanocodex_ui.js" "$staging/nanocodex_ui_bg.wasm" | shasum -a 256 | cut -c1-16)"
mkdir -p "$output/$hash"
cp "$staging/"* "$output/$hash/"
sed "s/@BUNDLE@/$hash/g" "$root/crates/nanocodex-ui/web/index.html" > "$output/index.html"
echo "GPUI web bundle: $output/$hash"
