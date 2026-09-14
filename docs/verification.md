# What has actually been proved, and what has not

Live run on a clean Box (`bx_mu5ts46y`, Ubuntu 24.04.4 x86_64, kernel 6.8.0-117, systemd 255),
created empty (`noEnv: true`) for this purpose. Everything below was executed as root on that
machine, not in a fixture. Where a fixture was used, it says so.

Artifact: **75 files, `0.3.0-e459131e4ca0`**, upgraded live to `0.3.1-6e69ba9a4771`.
Runtime: official **Node 22.23.2 linux-x64**, sha256 `d60acfe0…f307`.

## Runtime (settled empirically)

The pinned tarball was downloaded on the Box, its digest verified against
`nodejs.org/dist/v22.23.2/SHASUMS256.txt`, unpacked, and **executed there**: it reports
`v22.23.2` and every shared library resolves on this Ubuntu. The laptop's Node v26.7.0 (Arch)
is never copied — it is not merely discouraged, it would not run here.

The machine image still ships the trap that broke the earlier pilot:
`/usr/local/bin/node` is a symlink into `/home/user/.nvm/versions/node/v24.18.1/bin/node`, and
`/usr/bin/node` is v20.20.2, below Pi's `>=22.19.0`. The unit therefore executes
`/opt/imperfect/runtime/bin/node`, a real root-owned file. `assertTreeBound()` refuses to
install a runtime whose `bin/node` is a symlink at all.

## Isolation — PASS

- Runtime user `imperfect` — uid 996, shell `/usr/sbin/nologin`, **no** privileged group.
- It **cannot** write `/opt/imperfect`, `/opt/imperfect/releases`, or the live release
  directory; both the write test and an actual file-creation attempt were refused.
- It **can** write `/opt/imperfect/data`, which is where all personal state lives.
- `ExecStart` is a real file, verified not to be a symlink, and the running process is owned by
  `imperfect`.

`/opt` on a Box is owned by `user` (uid 1000) mode 755. That account already holds passwordless
sudo *and* docker group membership, so it is root-equivalent and this grants it nothing new.
The boundary that matters is the runtime user's, and that is what was tested.

## Browser — PASS, phone and desktop

Real Chromium through the supplier's protected HTTPS route, at **390×844** and **1440×900**:

- page loads 200, first-run authentication prompt opens
- **39 providers** arrive over the authenticated WebSocket — a real SDK response, not a fixture
- a prompt with no credential produces a **visible** failure message
- no page errors, no 404s, no horizontal overflow at either size
- foreign `Origin` → **403**; a tampered access token → refused; a forged `Host` is refused by
  the edge before HTTP is spoken
- on the raw machine port, the application's own Host guard answers **403** for an untrusted
  Host and **200** only for the configured hostname

## Lifecycle — PASS

| Step | Result |
|---|---|
| service restart | sentinel byte-identical, release unchanged, healthy in 2s |
| real upgrade `0.3.0` → `0.3.1` | release pointer advanced, MainPID changed, state survived |
| deliberately bad upgrade | installer exited 1, **rolled back** to `0.3.1`, healthy, state intact |
| snapshot-safe stop → archived → resume | release, sentinel and runtime binary all identical |

The bad release throws during module initialisation, **before** the server binds, so a
crash-looping process cannot answer a health probe by luck.

After resume the unit was still `enabled` but momentarily `inactive` while systemd started it,
and the application answered healthy shortly after — the same ordering seen in the earlier
pilot. **Customer readiness must gate on authenticated application health, never on the
supplier's machine state.**

## Backup and restore — PASS, with a caveat that matters

`/opt/imperfect/data` was archived, a **loopback ext4 filesystem** was created and mounted, the
archive restored onto it, and the sentinel came back byte-identical. The restore target was
asserted to be a *different device* from the original. The running machine stayed healthy
throughout.

**The product ships no backup command.** This proves the data tree is restorable by ordinary
means; it does not mean a backup feature exists. Writing one is outstanding work.

## Not proved — do not claim these

- **Conversation persistence across resume.** Pi does not persist a session until an assistant
  message exists, and no model credential was placed on the test machine, so no conversation
  was ever created. Restart/resume was proved with a sentinel file instead. A real
  model-authenticated journey remains unproved.
- **A real user's model authentication and tool use.** Operator credentials were deliberately
  **not** injected into the test machine; doing so would have manufactured an onboarding
  success that no customer would experience.
- **Ingress.** This install has no second application-password gate. Access was the supplier's
  protected route plus the application's own Host/Origin pinning and Pi's provider
  authentication. The earlier pilot added a Caddy password precisely because Box also opens the
  raw machine port. **That gate is missing here and is outstanding work.**
- **Loopback-only binding is not reachable by the supplier's edge.** Hosting port 5067 directly
  returned 502. The browser proof was taken through a throwaway proxy that was created for the
  test and removed before the snapshot. A real deployment needs a proper fronting proxy — which
  is the same component that should carry the password gate above.
- **Dedicated-user isolation on vaita.** Root is not available there yet; see below.
- **Desktop streaming.** Not implemented, deliberately.
- **Second-account denial and session recovery.** Control-plane behaviour, untouched here.

## Inherited test failures (pre-existing, not caused by this work)

`npm test` fails 15 tests. The identical set fails in a pristine export of the upstream commit
`82cbd4b`, line for line, so none of it comes from the installer work:

- `extensions/guey-live` (10) — `pi.registerCommand is not a function`, `clear_queue`
- `native/test/native.test.mjs` — TUI theme snapshot expectation
- `npm run test:browser` (3) — reconnect-visibility timing, a knowledge-error timeout, and the
  phone shell still requesting `/omarchy/background` after Omarchy was removed

`npm run test:install` is **7/7 green**, and that is the suite that covers this work.

## Admin migration to vaita

Root is not available on vaita: `sudo -n true` is denied, root SSH is denied, and the docker
socket is denied. The existing workshop runs as a **user** service (`imperfect-machine` under
`dacre`), which does not meet the isolation boundary above. Faking it with a same-uid service
would not be isolation, so it is not offered.

The reviewed artifact and an exact root command are **staged** at
`vaita:/home/dacre/imperfect-staging/20260914T025517Z` (digest `39972f0c…`, `ADMIN-RUN-AS-ROOT.sh`
written but not run). It would install on port **5068** so `imperfect-machine` on 5067 stays up.
The existing unit is left running and untouched until an administrator with real root runs that
script. Noah's authenticated Pi profile at `~/.pi/imperfect` must be preserved and must **never**
be copied into a customer template.
