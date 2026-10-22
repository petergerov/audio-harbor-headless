# Raspberry Pi: WLAN per Kommandozeile (für Einsteiger)

Diese Anleitung gilt für **Raspberry Pi OS Bookworm** (2023 und neuer). Dort steuert **NetworkManager** das WLAN. Du brauchst nur ein Terminal (SSH oder Tastatur am Pi).

> Ziel: WLAN verbinden, ohne Desktop. Danach kannst du z. B. Audio Harbor Headless installieren — siehe [LINUX.md](LINUX.md).

---

## 0. Kurz: Was du brauchst

| Ding | Beispiel |
|---|---|
| WLAN-Name (SSID) | `FritzBox-Gast` |
| Passwort | das WLAN-Passwort |
| Land | `DE` (Deutschland) |

Zuerst einloggen (Lokal oder per Ethernet/Kabel):

```bash
# falls du noch als root bist — besser als normaler User:
whoami
```

Die meisten Befehle unten brauchen `sudo` (Administrator).

---

## 1. Der einfachste Weg: Textmenü (`nmtui`)

Wenn du Tippen hasst, nimm das Menü:

```bash
sudo nmtui
```

Dann:

1. **Activate a connection** — vorhandenes WLAN wählen, oder  
2. **Edit a connection** → **Add** → **Wi-Fi**
3. Name / SSID und Passwort eintragen
4. Mit Pfeiltasten + Enter bestätigen, mit Esc zurück
5. **Quit**

Fertig. Weiter bei [§ 4 Prüfen](#4-prüfen-ob-es-klappt).

---

## 2. Der Befehls-Weg (`nmcli`) — Schritt für Schritt

### 2.1 WLAN einschalten

```bash
sudo nmcli radio wifi on
```

### 2.2 Netze in der Nähe anzeigen

```bash
nmcli device wifi list
```

Du siehst eine Tabelle. In der Spalte **SSID** steht der Netzname. Merke dir genau die Schreibweise (Groß/Klein zählt).

Falls die Liste leer ist:

```bash
sudo nmcli device wifi rescan
nmcli device wifi list
```

### 2.3 Verbinden (einmal, Passwort in Anführungszeichen)

Ersetze `MEIN-WLAN` und `GEHEIM` durch deine Werte:

```bash
sudo nmcli device wifi connect "MEIN-WLAN" password "GEHEIM"
```

Beispiel:

```bash
sudo nmcli device wifi connect "FritzBox-Gast" password "meinPasswort123"
```

Bei Erfolg erscheint etwas wie: `Device 'wlan0' successfully activated`.

NetworkManager speichert die Verbindung. Nach dem nächsten Boot verbindet der Pi sich meist von allein.

### 2.4 Land setzen (wichtig, sonst oft kein WLAN)

In der EU/DE muss das Funkland stimmen:

```bash
sudo raspi-config nonint do_wifi_country DE
```

Oder interaktiv:

```bash
sudo raspi-config
```

→ **Localisation Options** → **WLAN Country** → **DE** → Finish.

Danach ggf. nochmal verbinden (Schritt 2.3).

---

## 3. Nützliche Alltagsbefehle

| Was | Befehl |
|---|---|
| Status (kurz) | `nmcli general status` |
| Welches Gerät, welche IP? | `nmcli device status` |
| Aktive Verbindung | `nmcli connection show --active` |
| IP-Adresse anzeigen | `hostname -I` |
| Trennen | `sudo nmcli device disconnect wlan0` |
| Gespeicherte WLANs | `nmcli connection show` |
| Ein gespeichertes WLAN löschen | `sudo nmcli connection delete "MEIN-WLAN"` |
| Nochmal mit anderem Passwort | zuerst löschen, dann neu `connect` |

WLAN aus / an:

```bash
sudo nmcli radio wifi off
sudo nmcli radio wifi on
```

---

## 4. Prüfen, ob es klappt

```bash
# IP da? (sollte z. B. 192.168.x.x zeigen)
hostname -I

# Internet?
ping -c 3 1.1.1.1

# DNS?
ping -c 3 google.com
```

Wenn die erste `ping` geht, aber `google.com` nicht: oft DNS/Router-Thema, nicht „WLAN kaputt“.

---

## 5. Typische Fehler (Dummies-Edition)

### „Error: No network with SSID …“
- Name falsch geschrieben → `nmcli device wifi list` nochmal anschauen  
- Zu weit weg / 5‑GHz auf einem Pi, der nur 2,4 GHz kann (ältere Modelle)  
- Land nicht gesetzt → [§ 2.4](#24-land-setzen-wichtig-sonst-oft-kein-wlan)

### „Secrets were required, but not provided“
- Passwort fehlt oder ist falsch → Befehl mit `password "…"` wiederholen

### Gerät heißt nicht `wlan0`
Manche Images nutzen `wlan0`, manchmal siehst du etwas anderes:

```bash
nmcli device status
```

Dann z. B.:

```bash
sudo nmcli device wifi connect "MEIN-WLAN" password "GEHEIM" ifname wlan0
```

### Nur Kabel, kein WLAN-Chip
Ein Pi **ohne** WLAN (z. B. manche älteren Compute Modules) braucht einen USB-WLAN-Stick. Dann erscheint erst nach dem Stick ein Wi‑Fi-Gerät in `nmcli device status`.

### Ich bin ausgesperrt (nur WLAN, falsches Passwort)
Mit Ethernet-Kabel verbinden, oder Bildschirm + Tastatur, dann Passwort neu setzen bzw. Verbindung löschen und neu anlegen.

---

## 6. Optional: feste IP (nur wenn du weißt, warum)

Meist unnötig — der Router vergibt die IP. Wenn du trotzdem eine feste Adresse willst (Beispiel `192.168.1.50`, Router `192.168.1.1`):

```bash
# Name der aktiven Verbindung nachschauen:
nmcli connection show --active

sudo nmcli connection modify "MEIN-WLAN" \
  ipv4.method manual \
  ipv4.addresses 192.168.1.50/24 \
  ipv4.gateway 192.168.1.1 \
  ipv4.dns "1.1.1.1 8.8.8.8"

sudo nmcli connection up "MEIN-WLAN"
```

Zurück auf DHCP (automatisch):

```bash
sudo nmcli connection modify "MEIN-WLAN" ipv4.method auto
sudo nmcli connection up "MEIN-WLAN"
```

---

## 7. Ältere Raspberry Pi OS (Bullseye und früher)

Dort war oft **kein** NetworkManager, sondern `wpa_supplicant` + `dhcpcd`. Kurz:

```bash
sudo raspi-config
```

→ **System Options** → **Wireless LAN** → Land, SSID, Passwort.

Oder Datei `/etc/wpa_supplicant/wpa_supplicant.conf` bearbeiten (nur wenn du weißt, was du tust). Auf **Bookworm** bitte **nicht** so mischen — dort `nmcli` / `nmtui` verwenden.

Prüfen, welches System du hast:

```bash
cat /etc/os-release
# bei VERSION_CODENAME=bookworm → diese Anleitung
```

---

## 8. Mini-Checkliste

1. `sudo nmcli radio wifi on`  
2. `sudo raspi-config nonint do_wifi_country DE`  
3. `nmcli device wifi list`  
4. `sudo nmcli device wifi connect "SSID" password "PASSWORT"`  
5. `hostname -I` und `ping -c 3 1.1.1.1`  

Wenn das steht: weiter mit der Harbor-Installation in [LINUX.md](LINUX.md).
