# imperfect.os

Product source for imperfect computers, **public and AGPL-3.0-only** as of 2026-09-15. The public name and domain are **imperfect computers** / **imperfect.computer** — the brand is the domain, this repository is the machine. They were separated on 2026-09-17: the machine app is `locusrifle/imperfect.os`, and `locusrifle/imperfect.computer` is now the account door, which is private and stays private.

Being public changes two habits. Nothing customer-specific, no fleet key and no account store may land here, as before — but now a mistake is published rather than merely misplaced. And code by other authors needs its licence carried with it: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before vendoring anything, and do not vendor GPL v2 code, which the AGPL cannot absorb.

Read [README.md](README.md) and [docs/operations.md](docs/operations.md) before installing. Architecture and honesty about upstream live in [docs/architecture.md](docs/architecture.md) and [docs/upstream.md](docs/upstream.md).

Do not duplicate the door (`locusrifle/imperfect.computer`, checked out at `vaita:/home/dacre/imperfect-door` — the directory kept its old name). Do not put fleet keys, account stores, or customer data in this tree. Do not copy a laptop Node binary onto Ubuntu; the installer unpacks a pinned official linux-x64 Node tarball.
