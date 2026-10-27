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
| `HARBOR_REINSTALL` | — | `1`: install even when this version is installed — for a release rebuilt under the same version number |

```bash
curl -fsSL …/install-linux.sh | sudo HARBOR_VERSION=v1.0.0 HARBOR_USER=pi bash
```

### Which package

There is a `.deb` for `arm64` (Raspberry Pi and other 64-bit ARM boards) and for `amd64` (x86_64 PCs); the installer picks the right one. A release holds the platforms ticked when it was built (see [Release workflow](#release-workflow)) — **v1.0.6 has all but Windows**: `.deb` and `.tar.gz` for `arm64` and `amd64`, `.pkg` and `.tar.gz` for Apple Silicon and Intel Macs. If a release lacks your CPU, the installer stops with `no .deb for <arch> in that release`; pick an older one with `HARBOR_VERSION=<tag>`. By hand, check the CPU first:

```bash
dpkg --print-architecture   # arm64 or amd64 — the <arch> in the file name
```

The files of a release ([release page](https://github.com/petergerov/audio-harbor-headless/releases)):

| File | For |
|---|---|
| `audio-harbor-headless_<ver>_arm64.deb` (+ `.sha256`) | Raspberry Pi OS / Debian / Ubuntu on arm64 — this guide |
| `audio-harbor-headless_<ver>_amd64.deb` (+ `.sha256`) | Debian / Ubuntu on x86_64 — this guide |
| `install-linux.sh` | the one-line installer above; picks the `.deb` for the CPU |
| `audio-harbor-headless-<ver>-linux-<arm64\|x64>.tar.gz` | portable, no service — see [Portable `.tar.gz`](#portable-targz) |
| `audio-harbor-headless-<ver>-darwin-<arm64\|x64>.pkg` (+ `.sha256`) | Mac (Apple Silicon / Intel) — signed installer |
| `audio-harbor-headless-<ver>-darwin-<arm64\|x64>.tar.gz` | Mac, portable |

Check a download against its checksum: `sha256sum -c audio-harbor-headless_<ver>_<arch>.deb.sha256` (in the same folder).

A package for the wrong CPU fails in apt with `Depends: libc6:amd64 (>= 2.32) but it is not installable` (or `:arm64`): apt treats it as a foreign architecture.

The `.deb` by hand (here `arm64`; on a PC `amd64`), then the first checks (`audioharbor` = the service user, see [Dedicated service user](#dedicated-service-user)):

```bash
cd /tmp && curl -fLO https://github.com/petergerov/audio-harbor-headless/releases/download/v1.0.6/audio-harbor-headless_1.0.6_arm64.deb
sudo HARBOR_USER=audioharbor apt install ./audio-harbor-headless_1.0.6_arm64.deb

sudo systemctl status audioharbor@audioharbor                    # running?
journalctl -u audioharbor@audioharbor -b --no-pager | tail -40   # URL and QR code
sudo -u audioharbor audioharbor pair                             # PIN (the first remote shows it itself)
```

The `./` matters — without it apt looks for the name in its repositories. `curl -f` stops on a missing file (a wrong version or CPU) instead of saving GitHub's `Not Found` page as `.deb` — apt would then report `Invalid archive signature`. Downloading to `/tmp` keeps the file readable for apt's download user `_apt` (see [Troubleshooting](#troubleshooting)). apt pulls in the dependencies (ALSA, sudo). Then open `http://audioharbor.local:8787` on the phone — or the IP URL from the journal — and add music under Settings → Sources.

### Dedicated service user

Installing needs root (apt), but the service should run as a normal user, not as root. To run it as a dedicated user such as `audioharbor`:

```bash
sudo adduser audioharbor   # if it does not exist yet
```

Logged in as `audioharbor` with sudo rights — `$SUDO_USER` picks it up:

```bash
curl -fsSL …/install-linux.sh | sudo bash
```

As root or another admin user — name it explicitly:

```bash
curl -fsSL …/install-linux.sh | sudo HARBOR_USER=audioharbor bash
```

Always pass `HARBOR_USER` when installing as someone else: without it the package falls back to the user with UID 1000, on a Pi usually the first account created, not `audioharbor`. The same works for the `.deb` alone: `sudo HARBOR_USER=audioharbor apt install ./audio-harbor-headless_…_arm64.deb`.

Afterwards:

- data lives in `/home/audioharbor/.audio-harbor-headless/`,
- service and log: `sudo systemctl status audioharbor@audioharbor`, `journalctl -u audioharbor@audioharbor -f`,
- terminal commands as that user, so they use the same data: `sudo -u audioharbor audioharbor pair`,
- music folders and mounts must be readable for `audioharbor` — for CIFS use `uid=audioharbor,gid=audioharbor` in `/etc/fstab`,
- no need to add it to the `audio` group, the service does that (`SupplementaryGroups=audio`).

If the service already runs for another user, switch it: `sudo systemctl disable --now audioharbor@pi && sudo systemctl enable --now audioharbor@audioharbor`.

Without the script — download the `.deb` from the [release page](https://github.com/petergerov/audio-harbor-headless/releases) and:

```bash
sudo apt install ./audio-harbor-headless_1.0.6_arm64.deb
```

### Requirements

- 64-bit OS on `arm64` or `amd64`. On a Raspberry Pi: the 64-bit Raspberry Pi OS, Pi 3 or newer. 32-bit (`armhf`) has no package. See [Which package](#which-package).
- glibc 2.32 or newer: Raspberry Pi OS Bookworm or newer, Debian 12+, Ubuntu 22.04+. The package states the exact version in `Depends`.
- systemd for the service. Without it (e.g. in a container) the package installs and `audioharbor` starts by hand.

Tested on Debian 12 (Bookworm) and Debian 13 (Trixie), arm64.

## First steps

1. Open `http://audioharbor.local:8787` on the iPhone (Safari → Share → Add to Home Screen keeps it as an app).
2. Connect: no code is needed — the remote opens straight away on any device on the network, the iOS app too. To let in only paired devices, turn on Settings → About → **Require Pairing Code**. Then a new device pairs once with the PIN: as long as none is paired, the remote shows **First Setup** with the PIN filled in; later the PIN is in Settings → About on a paired device (**New PIN** makes a fresh one), or `audioharbor pair` as the service user. The PIN changes after each pairing.
3. Add music: Settings → Sources → Choose Folder… walks the host's folders — no path to type. A USB drive is set up there too, see [Music on a USB drive](#music-on-a-usb-drive). Adding a folder does not scan it: **Library → Update Library → Rescan**, at the top of Sources once there is a folder, drive or share, reads it and shows the progress.
4. Pick the DAC: Settings → Output → Device. Each output is listed once — `SMSL USB AUDIO`, `bcm2835 Headphones`, `vc4-hdmi-0` — as `aplay -l` shows them, not every ALSA alias of it. The mode decides how it is opened: **Shared** through `plughw` (converts format and rate), **Exclusive** / **DoP** directly as `hw:` (bit-perfect; a rate the DAC lacks is refused, not resampled). The Deck badge shows what the DAC gets, e.g. `96 kHz / 24-bit · Exclusive`, or `96 → 48 kHz / 16-bit · Shared` when `plughw` converts for a card that cannot do the file's rate.

Settings → About shows the host: CPU load (on a Raspberry Pi with the SoC temperature), memory, and free space on the disk with Harbor's data and on each drive with library folders — refreshed every 3 s while open. An unplugged drive is left out. Below the version, **Software Update** installs a newer release, see [Update from the remote](#update-from-the-remote).

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
| `/usr/libexec/audio-harbor-headless/harbor-drive` | root helper that sets up drives in `/etc/fstab` (see [Music on a USB drive](#music-on-a-usb-drive)) |
| `/usr/libexec/audio-harbor-headless/harbor-update` | root helper that installs a newer release (see [Update from the remote](#update-from-the-remote)) |
| `/etc/sudoers.d/audio-harbor-headless` | lets the group `harbor-drives` run these two helpers, and nothing else, as root |
| `/etc/audio-harbor-headless/<name>.cred` | login of an SMB share set up from the remote (root only), created then |
| `/opt/audio-harbor-headless/engine/build/Release/harbor-fx` | the plugin rack's process (CLAP, VST3, LV2 through `liblilv-0-0`), started by the engine when the rack holds plugins |
| `/opt/audio-harbor-headless/plugins/` | shipped plugins: `clap/lsp-plugins.clap` (LSP Plugins, no UI), `presets/lsp/` (LSP's own presets) and `LICENSES/` |
| `~/.audio-harbor-headless/` | config, catalogue, artwork, PIN, plugin rack — of the service user, created on first start |

## The service

`audioharbor@<user>` runs `start.sh serve` as `<user>` with the extra groups `audio` and `harbor-drives` (`SupplementaryGroups=`), so it can open ALSA devices, set up drives and install updates without changing the user account. It waits for `network-online.target` and `remote-fs.target` (network shares, see below) and restarts 5 s after a crash.

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

## Plugins

The rack (Settings → Rack, and the fader button on the Deck) runs LV2, CLAP and VST3 effects.

**Included:** the package ships [LSP Plugins](https://lsp-plug.in) 1.2.35 as one CLAP file, `/opt/audio-harbor-headless/plugins/clap/lsp-plugins.clap`, built without the UI (only `libsndfile` needed; licence in `plugins/LICENSES/`). Add Plugin lists five of them first: **Graphic EQ** (Graphic Equalizer x16), **Parametric EQ** (Parametric Equalizer x16), **Mastering Compressor** (Multiband Compressor x8), **Mastering Limiter** (Limiter) and **Loudness Compensation** (Loudness Compensator). LSP's own presets come along under `plugins/presets/lsp/` (parametric EQ, compressor and more) and are listed in each plugin's sheet. `install.sh` builds the same file (`packaging/build-plugins.sh`, a few minutes on a Pi).

**More** from apt — note that the distribution's plugin packages pull in X11 / OpenGL libraries (~240 MB on a Pi without a desktop):

```bash
sudo apt install x42-plugins          # x42 EQ, digital peak limiter, compressor (LV2)
sudo systemctl restart audioharbor@pi  # or: Settings → Rack → Add Plugin → Look Again
```

LV2 is found where lilv looks (`/usr/lib/lv2`, `/usr/local/lib/lv2`, `~/.lv2` of the service user, or `LV2_PATH`), CLAP in the shipped `plugins/clap`, `/usr/lib/clap`, `~/.clap` and `CLAP_PATH`, VST3 in `~/.vst3`, `/usr/lib/vst3`, `/usr/local/lib/vst3` and `VST3_PATH` (a bundle needs a build for the machine: `Contents/aarch64-linux` on a Pi, `x86_64-linux` on a PC). Only stereo effects can go in the rack. Plugins run in `harbor-fx`, not in the host: one that crashes does not stop the music.

**Plugin windows on a desktop:** on a Linux machine with an X11 desktop (or XWayland), a plugin's own editor can open on its screen — *Open the Plugin Window* in the plugin's sheet. CLAP and VST3 editors and LV2 X11 UIs (x42, LSP from apt, Calf …) are embedded in a window of their own; what is turned there reaches the remote within a moment. The included LSP CLAP has no editor (built without its UI). harbor-fx needs a `DISPLAY` and the right to use it, which the service does not have; on a desktop, give it both with a drop-in (`sudo systemctl edit audioharbor@pi`):

```ini
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/pi/.Xauthority
```

or run the host in the desktop session (`./start.sh`). Without a `DISPLAY` (a Pi without a desktop) nothing changes: libX11 is only opened when there is one, so the package needs no X11 libraries.

## Music on a USB drive

### From the remote

Plug in the drive, then Settings → Sources → Drives:

1. **Look for Drives** lists the drives the host sees — label, size, file system. The disk the system runs from is never listed.
2. **Set Up** asks for a short name (letters, digits, `-` `_` `.`), adds the drive to `/etc/fstab` and mounts it read-only at `/mnt/harbor/<name>`.
3. The folder picker opens on the drive: tap through to the music folder and **Add**. **Add Folder** on the drive's row adds more folders later.

The `•••` menu of a set-up drive:

- **Eject** unmounts it — safe to unplug. The host mounts it again on the next access.
- **Remove Drive…** takes it out of `/etc/fstab`, removes `/mnt/harbor/<name>` and its folders from the library. The files on the drive stay.

What it does:

- The fstab line is the one below: by UUID, `ro`, `nofail`, `x-systemd.automount`, `x-systemd.device-timeout=5s` — boot does not wait for the drive, plugging it in again needs nothing, and while it is unplugged an access fails after 5 s instead of hanging. exFAT, FAT and NTFS get the service user as owner (`uid=`, `gid=`); ext4, btrfs and xfs keep the permissions on the drive.
- A drive the desktop already mounted under `/media/…` is taken over; a drive mounted anywhere else is not listed.
- Each change backs up the previous fstab to `/etc/fstab.harbor-backup`. The helper only edits entries below `/mnt/harbor/`, marked `# audio-harbor-headless drive`.
- It works when Harbor runs as the `audioharbor@` service: the service has the group `harbor-drives`, and `/etc/sudoers.d/audio-harbor-headless` lets that group run `/usr/libexec/audio-harbor-headless/harbor-drive` as root. The helper checks its arguments (UUID, name) and refuses the system disk. A manual `audioharbor` in a terminal has no such group — the remote then says so and you use the way below.
- NTFS needs the `ntfs3` kernel module (Raspberry Pi OS has it) or `sudo apt install ntfs-3g`.

The host does not watch the folders: after copying new albums onto the drive press Rescan.

### By hand

Raspberry Pi OS Lite mounts nothing on its own, and the desktop only mounts a drive under `/media/<desktop user>/…` while someone is logged in — readable for that user, often not for the service user. Mount the drive in `/etc/fstab` instead: it is there at boot, without a login, and comes back when you plug it in again.

Find the partition, its file system and UUID:

```bash
lsblk -f
```

```
NAME   FSTYPE LABEL UUID                                 MOUNTPOINTS
sda
└─sda1 exfat  MUSIC 1A2B-3C4D
```

Create the mount point and add one line to `/etc/fstab` (`sudoedit /etc/fstab`), depending on `FSTYPE`:

```bash
sudo mkdir -p /mnt/music
```

```
# exFAT — owner comes from uid/gid
UUID=1A2B-3C4D  /mnt/music  exfat  ro,uid=audioharbor,gid=audioharbor,nofail,x-systemd.automount,x-systemd.device-timeout=5  0  0

# NTFS — the same with ntfs3
UUID=0123456789ABCDEF  /mnt/music  ntfs3  ro,uid=audioharbor,gid=audioharbor,nofail,x-systemd.automount,x-systemd.device-timeout=5  0  0

# ext4 — owner and permissions are stored on the drive
UUID=0f1e2d3c-…  /mnt/music  ext4  ro,nofail,x-systemd.automount,x-systemd.device-timeout=5  0  0
```

Replace `audioharbor` with the service user. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart mnt-music.automount
ls /mnt/music
```

With ext4 the service user needs read access to the files; if it lacks it, remount writable once and open them up:

```bash
sudo mount -o remount,rw /mnt/music
sudo chmod -R a+rX /mnt/music
sudo mount -o remount,ro /mnt/music
```

Add `/mnt/music` in the remote under Settings → Sources → Add Folder.

- `nofail`: the Pi boots without the drive.
- `x-systemd.automount`: the drive mounts on first access, also after unplugging and plugging it in again — no reboot.
- `ro`: the host only reads; pulling the drive cannot damage the file system. Still, `sudo umount /mnt/music` before unplugging is cleaner.
- The fstab line is bound to this drive's UUID. Another drive needs its own line and mount point.
- While the drive is unplugged a scan keeps its tracks in the library. The host does not watch folders: after copying new albums press Rescan in the remote or run `sudo -u audioharbor audioharbor rescan`.

## Music on a network share

Several hosts can play one library: the music lies on a NAS (or on one host that shares it), every host mounts it and adds the mounted folder under Settings → Sources. Local folders and shares together appear as one library in the remote. The engine reads the files like local ones — DSD, SACD ISO, seeking and gapless work as usual; a wired LAN or good Wi‑Fi is plenty.

### SMB share from the remote

Settings → Sources → Drives & Network Shares → **Add Network Share…**:

| Field | Example |
|---|---|
| Server | `nas.local` or `192.168.1.10` (also `//nas.local/music` pasted whole: the share part is dropped, enter it below) |
| Share | `music` — the share name, not a folder below it (pick that in the next step) |
| User / Password | the NAS account; user empty = guest |
| Domain | only for a Windows domain or a workgroup login |
| Name | the folder under `/mnt/harbor`; default: the share name |

**Add** mounts it read-only at `/mnt/harbor/<name>` and keeps it in `/etc/fstab`; a wrong password or server comes back as the error (`mount error(13): Permission denied`) and nothing is left behind. The folder picker then opens on the share — tap through to the music and **Add**, as for a drive. The share's `•••` menu has **Unmount** (it mounts again on the next access) and **Remove Share…** (fstab entry, stored login and its library folders).

- The fstab line: `//server/share  /mnt/harbor/<name>  cifs  ro,uid=…,gid=…,file_mode=0444,dir_mode=0555,iocharset=utf8,credentials=/etc/audio-harbor-headless/<name>.cred,nofail,_netdev,x-systemd.automount,x-systemd.mount-timeout=15s` — boot does not wait for the NAS, and an unreachable NAS fails within 15 s instead of hanging.
- The login is in `/etc/audio-harbor-headless/<name>.cred`, readable for root only (`600`), never in fstab; the remote sends the password to the root helper on its stdin, not on a command line.
- Needs `cifs-utils` — the package recommends it, so apt installs it along; otherwise the remote says `SMB needs cifs-utils`.
- Like drives, this works when Harbor runs as the `audioharbor@` service (see [Music on a USB drive](#music-on-a-usb-drive)).

### By hand

Mount the share read-only in `/etc/fstab` with systemd automount: boot does not wait for the NAS, and the share mounts on first access.

SMB (NAS, Windows, macOS, Samba) — `sudo apt install cifs-utils`:

```text
# /etc/fstab
//nas.local/music  /mnt/nas  cifs  ro,credentials=/etc/samba/nas.cred,uid=pi,gid=pi,iocharset=utf8,vers=3.0,nofail,_netdev,x-systemd.automount,x-systemd.mount-timeout=10  0  0
```

```text
# /etc/samba/nas.cred  (sudo chmod 600)
username=music
password=…
```

NFS — `sudo apt install nfs-common`:

```text
# /etc/fstab
nas.local:/volume1/music  /mnt/nas  nfs  ro,nofail,_netdev,x-systemd.automount,x-systemd.mount-timeout=10  0  0
```

Then:

```bash
sudo mkdir -p /mnt/nas
sudo systemctl daemon-reload
ls /mnt/nas                       # mounts it
```

and add `/mnt/nas` (or a folder below it) under Settings → Sources → Add Folder.

When the share is gone, the library keeps its tracks:

- The service starts after `remote-fs.target`, so shares from `/etc/fstab` are there before the first scan.
- A folder that is missing, unreadable, or empty while the catalogue still has tracks under it (an unmounted mount point) is skipped by the scan: tracks, labels and playlist entries stay. The journal says `Library: /mnt/nas is empty or unreadable (share not mounted?) — keeping its tracks`. Playing such a track fails until the share is back; the next scan picks up changes.
- To drop a folder's tracks for good, remove the folder under Settings → Sources — emptying it on disk is not enough.

Share the music from a Pi to the others with Samba (`sudo apt install samba`), read-only:

```text
# /etc/samba/smb.conf
[music]
   path = /media/pi/Music
   read only = yes
   guest ok = no
```

`sudo smbpasswd -a pi && sudo systemctl restart smbd` — the other hosts mount `//audioharbor.local/music`.

## Update

From the remote (below), or run the installer again, or `sudo apt install ./<new>.deb`. Running instances restart with the new version; a disabled service stays disabled.

A release rebuilt under the same version number (e.g. 1.0.6 again): apt sees the version as installed, so tell it to install anyway. With the installer — it downloads to `/tmp` itself:

```bash
curl -fsSL https://github.com/petergerov/audio-harbor-headless/releases/latest/download/install-linux.sh | sudo HARBOR_REINSTALL=1 bash
```

Or by hand with `--reinstall`. Download again first — an old file is the previous build — and into `/tmp`, not your home folder: apt reads packages as user `_apt`, who cannot enter a home directory with mode 700 (Raspberry Pi OS Bookworm, Debian 12+) and then ends with `Notice: Download is performed unsandboxed as root …` (harmless, see [Troubleshooting](#troubleshooting)):

```bash
cd /tmp && curl -fLO https://github.com/petergerov/audio-harbor-headless/releases/download/v1.0.6/audio-harbor-headless_1.0.6_arm64.deb
sudo apt install --reinstall ./audio-harbor-headless_1.0.6_arm64.deb
rm -f ~/audio-harbor-headless_*.deb   # an older copy in the home folder, if any
```

A file already in the home folder: `mv ~/audio-harbor-headless_1.0.6_arm64.deb /tmp/` and install `/tmp/audio-harbor-headless_1.0.6_arm64.deb`.

An update keeps config, library and pairing (`~/.audio-harbor-headless`): paired devices stay paired. A host that had paired devices before the code became optional keeps **Require Pairing Code** on; a new install starts without a code.

Check that the new build runs — the start time should be the moment of the install:

```bash
systemctl status audioharbor@audioharbor --no-pager | head -5
journalctl -u audioharbor@audioharbor -b --no-pager | tail -20
```

If the start time is older: `sudo systemctl restart audioharbor@audioharbor`.

Then in the remote:

- Settings → Output lists each output once — compare with `aplay -l`. A DAC picked with an older version (as `plughw:…`, `sysdefault:…`, `front:…` and the like) stays picked: it is mapped to its `hw:CARD=…` entry.
- Settings → Sources has Library → Update Library on top.
- Settings → About shows the version, Software Update and the host's CPU, memory and disks.

### Update from the remote

Settings → About → **Software Update** shows whether GitHub has a newer release. Harbor asks GitHub when About opens, at most once an hour; **Check for Updates** asks now. With a newer one: **Install <version>** → **Install and Restart**.

1. The remote calls `harbor-update install <tag>` through sudo. The helper starts the update as its own unit `audio-harbor-update` and returns — apt restarts `audioharbor@<user>`, and an update running inside the service would be stopped with it, halfway through apt.
2. In that unit it looks up the release on GitHub, downloads the `.deb` for this CPU (`dpkg --print-architecture`) and its `.sha256`, and checks the checksum, the package name and CPU, and that the version is newer than the installed one. Anything else it refuses: no other repository, no downgrade, no reinstall of the same version.
3. `apt-get update`, then `apt-get install` of the file — the same as the installer. The service restarts with the new version.
4. The remote shows the steps (*Downloading …*, *Installing …*, *Restarting Harbor…*) and reloads itself once the host answers with the new version, usually after a minute or two. Playback stops meanwhile.

It works for the `.deb` run as the `audioharbor@` service (the service has the group `harbor-drives`, see [The service](#the-service)), and from 1.0.3 on — 1.0.2 and older have no helper, so update those once by hand. A Mac or a portable `.tar.gz` gets the new version and **Release Notes** (the release page) in Settings, but no install button.

Progress goes to `/run/audio-harbor-headless/update`, the whole run to the journal:

```bash
journalctl -u audio-harbor-update --no-pager | tail -30
```

A failure shows under Software Update (e.g. `could not look up v1.0.3 on GitHub`); **Install** tries again. A release rebuilt under the same version number is not offered — use the installer with `HARBOR_REINSTALL=1` above.

## Remove

```bash
sudo apt remove audio-harbor-headless
```

Stops and disables every `audioharbor@…` instance and removes `/opt/audio-harbor-headless`. `~/.audio-harbor-headless` stays — delete it by hand for a clean slate. Drives and shares set up from the remote stay in `/etc/fstab` (marked `# audio-harbor-headless drive`, harmless with `nofail`), share logins in `/etc/audio-harbor-headless/` — remove them in the remote before, or delete the lines and files by hand. A later install enables the service again.

## Portable `.tar.gz`

For distributions without apt, or to run it without installing:

```bash
curl -LO https://github.com/petergerov/audio-harbor-headless/releases/latest/download/audio-harbor-headless-1.0.6-linux-arm64.tar.gz
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
| Output list differs from `aplay -l` (a card missing, or an output twice) | send `aplay -l` and a screenshot of Settings → Output. The list is one entry per playback device of each card, named like the card (`SMSL USB AUDIO`); a card with several outputs shows `card · output`. |
| Selected DAC shows as missing after an update | it is not connected, or its card id changed (`aplay -l`, the name after `card N:`). Pick it again under Settings → Output. |
| No DAC in the device list | `aplay -l` lists the ALSA cards; the user needs the `audio` group for a manual start (`sudo usermod -aG audio pi`, log in again). The service has it already. |
| `GLIBC_2.xx not found` | OS too old — see Requirements. |
| Music folder not readable | the service runs as the user — `sudo -u pi ls /path/to/music`. |
| Drives section says it needs the service | Harbor was started by hand (`audioharbor`), not as the service — `systemctl status audioharbor@<user>`. After an update from a version without the drive helper: `sudo systemctl restart audioharbor@<user>`. |
| Set Up fails | the message comes from the helper; details: `journalctl -b -u 'mnt-harbor-*'`. Undo by hand: the previous fstab is `/etc/fstab.harbor-backup`. |
| Network share: `mount error(13): Permission denied` | wrong user or password — or the NAS wants a domain / workgroup. Add it again with the right login. |
| Network share: `mount error(112)` / `Host is down` / timed out | server name or IP wrong, NAS asleep, or SMB1 only (switch the NAS to SMB2/3). `ping nas.local`. |
| `N: Download is performed unsandboxed as root as file '…deb' couldn't be accessed by user '_apt'` at the end of `apt install` | harmless — the install went through. apt reads packages as user `_apt`, who cannot enter a home directory with mode 700 (Debian 12+, Raspberry Pi OS Bookworm), so it read the file as root. Download the `.deb` with `cd /tmp` first (or `mv` it there), or use the installer — it downloads to `/tmp`. |
| `Invalid archive signature` / `could not locate member control.tar` | the `.deb` is no package — usually GitHub's `Not Found` page saved by `curl -LO` for a version or CPU that has no package (`cat` the file). Download with `curl -fLO`. |
| Software Update: *Installing updates works when Harbor runs as the audioharbor@ service* | Harbor was started by hand, not as the service — or the service still runs from before the update that brought the helper: `sudo systemctl restart audioharbor@<user>`. |
| Software Update: *… has no package for arm64 yet* | the release was built without your CPU (see [Which package](#which-package)); wait for one that has it. |
| Software Update failed | the reason is under Software Update; the whole run: `journalctl -u audio-harbor-update`. A held apt lock (another `apt` running) is waited for up to 5 min. |
| Remote stays at *Restarting Harbor…* | `systemctl status audioharbor@<user>` — the service did not come back; `journalctl -u audioharbor@<user> -b`. Reload the page once it runs. |
| `Depends: libc6:amd64 … but it is not installable` | the package is for another CPU — `dpkg --print-architecture`, see [Which package](#which-package). |
| Tracks of a share do not play | share not mounted: `ls /mnt/nas`, `systemctl status mnt-nas.automount`, `journalctl -b \| grep -i cifs`. |

## Building the packages

```bash
npm run package:deb    # npm run package:prebuilt + ./create-deb.sh
./create-deb.sh        # wraps an existing dist/packages/*-linux-<arch>.tar.gz
```

Needs a Linux host with `dpkg-deb`; builds for the host CPU. Output: `dist/packages/audio-harbor-headless_<ver>_<arch>.deb` and `.sha256`.

`create-deb.sh`:

- unpacks the prebuilt archive into `/opt/audio-harbor-headless`, drops `install.sh`, `create-package.sh` and `start.cmd`,
- adds the `audioharbor` symlink, the service template, the root helpers `harbor-drive` and `harbor-update` with their sudoers file, and the maintainer scripts from `packaging/linux/debian/`,
- reads the highest `GLIBC_x.y` symbol of `harbor_engine.node` and the bundled Node with `objdump` and puts it into `Depends: libc6 (>= x.y)`.

Maintainer scripts:

- `postinst` — creates the system group `harbor-drives` (drive and update helpers through sudo). Fresh install: `systemctl enable --now audioharbor@<user>`, user from `HARBOR_USER`, else `SUDO_USER`, else the user with UID 1000. Upgrade: `try-restart` of running instances. Skips systemd when it is not running.
- `prerm` — on removal: stop all instances and remove their `*.wants` links.

### Release workflow

`.github/workflows/release-packages.yml` (manual: Actions → Release packages → Run workflow, with the tag), job `linux`: runs on `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm` (arm64) inside a `debian:bookworm` container. Building on the Ubuntu 24.04 runner itself would link against glibc 2.39 and the binaries would not start on Raspberry Pi OS Bookworm (glibc 2.36). Each job builds the `.tar.gz` and from it the `.deb`. Job `build` makes the macOS `.pkg` and `.tar.gz` for `darwin-arm64` and `darwin-x64`, and the Windows `.zip`. The release job adds `install-linux.sh` whenever a Linux package is in it.

The run dialog has a checkbox per platform; job `plan` turns the ticked ones into the build matrices, so the others do not run and are not in the release:

| Input | Builds | Default |
|---|---|---|
| `macos_arm64` | Apple Silicon `.pkg` + `.tar.gz` | on |
| `macos_x64` | Intel `.pkg` + `.tar.gz` | on |
| `linux_arm64` | `_arm64.deb` + `.tar.gz` | on |
| `linux_x64` | `_amd64.deb` + `.tar.gz` | on |
| `windows_x64` | `.zip` + `.tar.gz` — experimental, packaging on `windows-2022` had rsync issues | off |

At least one must be ticked. From the command line: `gh workflow run release-packages.yml --ref main -f tag=v1.0.6 -f macos_x64=false -f windows_x64=true`; only the Raspberry Pi:

```bash
gh workflow run release-packages.yml --ref main -f tag=v1.0.6 \
  -f macos_arm64=false -f macos_x64=false -f linux_x64=false -f linux_arm64=true
```

In the run, the unticked group shows as skipped — named `matrix.platform`, as an empty matrix has no name to show; harmless. The release notes list every platform, also those not built.

Rebuilding a release under the same tag: delete the release, move the tag to the new commit and run the workflow again:

```bash
gh release delete v1.0.6 -y
git tag -f -a v1.0.6 -m "Audio Harbor Headless 1.0.6" && git push -f origin v1.0.6
gh workflow run release-packages.yml --ref main -f tag=v1.0.6   # add -f <platform>=false|true to choose
```

Hosts that have this version installed need `HARBOR_REINSTALL=1` or `apt install --reinstall` (see [Update](#update)); a new version number avoids that.

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
