# Desktop window

Same machine as the hosted computer. This is a window around `node start.mjs`, not a second app and not the locus.garden door.

```sh
git clone https://github.com/locusrifle/imperfect.computer.git
cd imperfect.computer
./desktop/install.sh
```

Needs Node 22+, Rust (`cargo`), and Linux WebKit (on Arch: `webkit2gtk-4.1 gtk3`). Data lives in `~/.imperfect`, not `/opt`. Box installs still use `install/imperfect.mjs`.
