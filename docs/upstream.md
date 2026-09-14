# Upstream relation

Guey remains the graphical Pi foundation. This product keeps that shared implementation in-tree rather than extracting a library or forking a framework.

Pi 0.85.1 owns agent behaviour (sessions, tools, compaction, provider auth). This tree owns the HTTP/WebSocket console, Host/Origin checks, and the Locus shell composition (`product: 'locusrifle'`, `brand: 'Locus'`).

Future upstream: if Guey is published separately, this repository should consume it as a dependency instead of remaining the only copy. That is not done today. Changes still belong in one place until a real second consumer exists.

The public account/control-plane source stays on vaita at `/home/dacre/locus-garden`. This repository never duplicates it.

The laptop console (`locusrifle.service` on Noah's machine) is not this product's install target.
