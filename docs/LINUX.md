# Audio Harbor Headless on Linux

Raspberry Pi OS, Debian and Ubuntu get a Debian package (`.deb`) with a systemd service: install it once, and the host starts at boot and comes back after a crash. Other distributions use the portable `.tar.gz`.

## Install

```bash
curl -fsSL https://github.com/petergerov/audio-harbor-headless/releases/latest/download/install-linux.sh | sudo bash
```

The script:

1. checks for apt and the CPU (`dpkg --print-architecture`: `arm64` or `amd64`),
2. looks up the release on GitHub and downloads `audio-harbor-headless_<ver>_<arch>.deb`,
3. installs it with `apt-get install` — the ALSA runtime (`libasound2`, on Trixie `libasound2t64`) comes along,
4. starts the server as the user who ran `sudo`.

| Variable (after `sudo`) | Default | Meaning |
|---|---|---|
| `HARBOR_VERSION` | latest release | release tag to install, e.g. `v1.0.0` |
| `HARBOR_USER` | `$SUDO_USER` | user the service runs as |

```bash
curl -fsSL …/install-linux.sh | sudo HARBOR_VERSION=v1.0.0 HARBOR_USER=pi bash
```

Without the script — download the `.deb` from the [release page](https://github.com/petergerov/audio-harbor-headless/releases) and:

```bash
sudo apt install ./audio-harbor-headless_1.0.0_arm64.deb
```

### Requirements

- 64-bit OS on `arm64` or `amd64`. On a Raspberry Pi: the 64-bit Raspberry Pi OS, Pi 3 or newer. 32-bit (`armhf`) has no package.
- glibc 2.32 or newer: Raspberry Pi OS Bookworm or newer, Debian 12+, Ubuntu 22.04+. The package states the exact version in `Depends`.
- systemd for the service. Without it (e.g. in a container) the package installs and `audioharbor` starts by hand.

Tested on Debian 12 (Bookworm) and Debian 13 (Trixie), arm64.

## First steps

1. Open `http://audioharbor.local:8787` on the iPhone (Safari → Share → Add to Home Screen keeps it as an app).
2. PIN for the Bonjour remote: `audioharbor pair` (as the service user).
3. Add music: Settings → Sources → Add Folder. USB drives are under `/media/<user>/…`.
4. Pick the DAC: Settings → Output → Device.

The QR code the host prints at start is in the journal:

```bash
journalctl -u audioharbor@pi -b --no-pager | tail -40
```

## What gets installed

| Path | Content |
|---|---|
| `/opt/audio-harbor-headless/` | host, web remote, native engine, bundled Node 22 (`runtime/bin/node`) |
| `/usr/bin/audioharbor` | symlink to `/opt/audio-harbor-headless/start.sh` |
| `/usr/lib/systemd/system/audioharbor@.service` | service template, one instance per user |
| `~/.audio-harbor-headless/` | config, catalogue, artwork, PIN — of the service user, created on first start |

## The service

`audioharbor@<user>` runs `start.sh serve` as `<user>` with the extra group `audio` (`SupplementaryGroups=audio`), so it can open ALSA devices without changing the user account. It waits for `network-online.target` and restarts 5 s after a crash.

Because it runs as a normal user, everything stays where a manual start puts it: `audioharbor pair` and `audioharbor rescan` in a terminal work on the same data, and folders the user can read are readable for the host.

```bash
sudo systemctl status audioharbor@pi
sudo systemctl restart audioharbor@pi
sudo systemctl stop audioharbor@pi          # until the next boot
sudo systemctl disable --now audioharbor@pi # no autostart
journalctl -u audioharbor@pi -f             # log
```

For another user: `sudo systemctl enable --now audioharbor@anna` (and `disable --now` the old one).

Terminal commands:

| Command | With the service running |
|---|---|
| `audioharbor` | does not start a second server (ports would clash); prints how to reach the service |
| `audioharbor stop` | stops the server; the service stays stopped until restart or reboot |
| `audioharbor pair` | shows the PIN (`--rotate` for a new one) |
| `audioharbor rescan` | re-indexes the library folders |

## Update

Run the installer again, or `sudo apt install ./<new>.deb`. Running instances restart with the new version; a disabled service stays disabled.

## Remove

```bash
sudo apt remove audio-harbor-headless
```

Stops and disables every `audioharbor@…` instance and removes `/opt/audio-harbor-headless`. `~/.audio-harbor-headless` stays — delete it by hand for a clean slate. A later install enables the service again.

## Portable `.tar.gz`

For distributions without apt, or to run it without installing:

```bash
curl -LO https://github.com/petergerov/audio-harbor-headless/releases/latest/download/audio-harbor-headless-1.0.0-linux-arm64.tar.gz
tar -xzf audio-harbor-headless-*-linux-arm64.tar.gz
cd audio-harbor-headless-*
sudo apt install -y libasound2   # ALSA runtime
./start.sh
```

No service; start it yourself (or write a unit like `packaging/linux/audioharbor@.service` with the path changed).

## Troubleshooting

| Symptom | Check |
|---|---|
| `audioharbor.local` not found | the host answers mDNS itself; it may have taken `audioharbor-2.local` (see the journal). Phone and Pi on the same network? Or use the IP URL from the journal. |
| Service does not start | `journalctl -u audioharbor@pi -b` — e.g. port 8787 taken by a manual `./start.sh`. |
| No DAC in the device list | `aplay -l` lists the ALSA cards; the user needs the `audio` group for a manual start (`sudo usermod -aG audio pi`, log in again). The service has it already. |
| `GLIBC_2.xx not found` | OS too old — see Requirements. |
| Music folder not readable | the service runs as the user — `sudo -u pi ls /path/to/music`. |

## Building the packages

```bash
npm run package:deb    # npm run package:prebuilt + ./create-deb.sh
./create-deb.sh        # wraps an existing dist/packages/*-linux-<arch>.tar.gz
```

Needs a Linux host with `dpkg-deb`; builds for the host CPU. Output: `dist/packages/audio-harbor-headless_<ver>_<arch>.deb` and `.sha256`.

`create-deb.sh`:

- unpacks the prebuilt archive into `/opt/audio-harbor-headless`, drops `install.sh`, `create-package.sh` and `start.cmd`,
- adds the `audioharbor` symlink, the service template and the maintainer scripts from `packaging/linux/debian/`,
- reads the highest `GLIBC_x.y` symbol of `harbor_engine.node` and the bundled Node with `objdump` and puts it into `Depends: libc6 (>= x.y)`.

Maintainer scripts:

- `postinst` — fresh install: `systemctl enable --now audioharbor@<user>`, user from `HARBOR_USER`, else `SUDO_USER`, else the user with UID 1000. Upgrade: `try-restart` of running instances. Skips systemd when it is not running.
- `prerm` — on removal: stop all instances and remove their `*.wants` links.

### Release workflow

`.github/workflows/release-packages.yml`, job `linux`: runs on `ubuntu-24.04` and `ubuntu-24.04-arm` inside a `debian:bookworm` container. Building on the Ubuntu 24.04 runner itself would link against glibc 2.39 and the binaries would not start on Raspberry Pi OS Bookworm (glibc 2.36). The job builds the `.tar.gz`, the `.deb`, and attaches `install-linux.sh` to the release.

### Testing locally (Docker)

Build like CI in `debian:bookworm` (on an Apple Silicon Mac that is arm64), then install into a container with systemd as PID 1:

```bash
docker run -d --name harbor-test --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw -v "$PWD/dist/packages:/out:ro" \
  <debian image with systemd, sudo and a user pi> /sbin/init
docker exec harbor-test bash -c 'SUDO_USER=pi apt-get install -y /out/audio-harbor-headless_*_arm64.deb'
docker exec harbor-test systemctl status audioharbor@pi
```

Containers on Docker Desktop do not reach players on the home network — good for packaging tests; test network players with the UPnP simulator.
