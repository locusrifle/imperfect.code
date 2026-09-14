# Snapshot

This computer is a sandbox. When nobody is here it stops. Coming back, or moving to another sandbox, is a snapshot restore — about a minute.

What is kept and moved: `/opt`, `/etc`, `/home/user`. This product and their files live under `/opt/imperfect`. HOME is `/opt/imperfect/data`. Put lasting work in the workspace.

What is not kept: `/tmp`, `/var/tmp`, `/var/lib` (Docker and friends), anything in RAM, running processes. A package you `apt` into `/usr` will not arrive in the next sandbox.

Don't start always-on daemons. Don't put their life outside `/opt/imperfect/data`.
