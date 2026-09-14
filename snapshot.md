# Snapshot

When nobody is here, this computer stops. Coming back is a snapshot restore, about a minute.

What lasts: `/opt`, `/etc`, `/home/user`. This product and their files live under `/opt/imperfect`. HOME is `/opt/imperfect/data`. Put lasting work in the workspace.

What does not last: `/tmp`, `/var/tmp`, `/var/lib` (Docker and friends), anything in RAM, running processes. A package you `apt` into `/usr` will not survive a transfer.

Don't start always-on daemons. Don't put their life outside `/opt/imperfect/data`.
