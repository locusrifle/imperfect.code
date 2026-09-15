# imperfect.computer

Product source for imperfect computers, **public and AGPL-3.0-only** as of 2026-09-15. The public name and domain are **imperfect computers** / **imperfect.computer**. This repository is the machine app, not the account door — that tree is private and stays private.

Being public changes two habits. Nothing customer-specific, no fleet key and no account store may land here, as before — but now a mistake is published rather than merely misplaced. And code by other authors needs its licence carried with it: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before vendoring anything, and do not vendor GPL v2 code, which the AGPL cannot absorb.

Read [README.md](README.md) and [docs/operations.md](docs/operations.md) before installing. Architecture and honesty about upstream live in [docs/architecture.md](docs/architecture.md) and [docs/upstream.md](docs/upstream.md).

Do not duplicate `vaita:/home/dacre/imperfect-door`. Do not put fleet keys, account stores, or customer data in this tree. Do not copy a laptop Node binary onto Ubuntu; the installer unpacks a pinned official linux-x64 Node tarball.
