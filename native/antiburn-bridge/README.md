# antiburn-bridge

imperfect-only. Guey stock does not ship this.

Pins **antiburn-local** (the upstream engine) and prints one JSON usage report
for `/usage` in the harness. Bump the pin; do not copy detectors.

Current pin: `antiburn-local-v0.7.1` (`c06456780a4e1cd6317168c79873092194d111bc`).
The crate lives at `~/.local/src/antiburn-local-0.7.1` from the engine source tarball.

```sh
cd native/antiburn-bridge
cargo build --release
./target/release/antiburn-bridge > ../public/antiburn-report.json
```
