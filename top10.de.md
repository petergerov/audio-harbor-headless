# Audio Harbor Headless — 10 Dinge, die die meisten Player nicht können

*[English](top10.md)*

## 1. Deine eigenen Studio-Plugins, gesteuert vom Handy

EQ, Raumkorrektur, Limiter: Audio Harbor nutzt die Plugins, die du schon hast, auf einem Gerät ohne Bildschirm. Die Regler bedienst du auf dem iPhone. Fünf gute Plugins sind kostenlos dabei, und die EQs haben richtige Oberflächen, auf denen du die Kurve mit dem Finger ziehst. Eine Taste schaltet alle Plugins ohne Unterbrechung aus und wieder ein, so hörst du den Unterschied sofort. Stürzt ein Plugin ab, läuft die Musik weiter, nur ohne den Effekt, und das Rack kommt von selbst zurück.

**Dahinter:**
- **CLAP, VST3, AU, LV2:** die vier verbreiteten Formate für Audio-Plugins, dieselben, die Tonstudios nutzen. AU gibt es nur auf dem Mac, LV2 vor allem unter Linux.
- **LSP Plugins:** eine kostenlose Open-Source-Plugin-Sammlung. Grafischer EQ, parametrischer EQ, Kompressor, Limiter und Loudness-Ausgleich daraus sind schon dabei.
- **harbor-fx:** Die Plugins laufen in einem eigenen, getrennten Programm. Ein Absturz dort kann den Player nicht mitreißen.
- **A/B-Bypass:** zwischen dem Klang mit und ohne Plugins umschalten, um beides zu vergleichen.

## 2. DSD an einen Netzwerk-Streamer, Bits unverändert

Die meisten Player machen aus DSD normales PCM, bevor es übers Netzwerk geht. Audio Harbor kann die DSD-Bits in den Stream verpacken, sodass ein DSD-DAC hinter deinem Streamer das Original bekommt. Bricht DSD im WLAN ab, schickt ein Schalter stattdessen einen leichteren Stream.

**Dahinter:**
- **DSD (Direct Stream Digital):** das Format der SACD. Statt Zahlen für die Lautstärke speichert es einen sehr schnellen Strom aus einzelnen Bits.
- **PCM (Pulse Code Modulation):** das „normale" digitale Audio wie auf der CD oder in FLAC: eine Zahl für die Lautstärke, viele tausend Mal pro Sekunde.
- **DoP (DSD over PCM):** ein Trick, der die DSD-Bits in PCM-Pakete verpackt. Die Geräte dazwischen halten es für PCM, und der DAC packt das originale DSD wieder aus.
- **WLAN-Modus:** macht aus DSD PCM mit 44,1 kHz / 16 Bit (CD-Qualität), etwa ein Drittel der Datenmenge.

## 3. Jeder Netzwerk-Player wird wie ein Kabel zum DAC

Ein Streamer, ein Verstärker, ein Fernseher oder eine Soundbar im Heimnetz wird zu einem Ausgang, genau wie ein DAC am Kabel. Kann der Player die Datei abspielen, bekommt er sie so, wie sie ist. Kann er es nicht, bekommt er eine verlustfreie Kopie, die beim Abspielen entsteht. Spulen funktioniert, Songs gehen lückenlos ineinander über, wenn der Player das kann, und du kannst die Musik zwischen dem Host und dem Netzwerk-Player hin- und herschieben, ohne die Stelle im Song zu verlieren.

**Dahinter:**
- **UPnP / DLNA:** die gemeinsame Sprache, mit der sich Netzwerkgeräte finden und Medien abspielen. Ein Gerät, das Musik abspielt, heißt *Renderer*.
- **SSDP:** der „Ist da jemand?"-Ruf von UPnP. Audio Harbor ruft alle 30 Sekunden, so taucht ein eingeschalteter Player nach wenigen Sekunden auf.
- **GetProtocolInfo:** die Liste der Formate, die der Player kann. Audio Harbor liest sie und schickt nur, was passt.
- **WAV im Flug:** Für ein Format, das der Player nicht kennt, macht der Host beim Abspielen WAV daraus (unkomprimiert, verlustfrei).
- **HTTP Range:** Der Player kann jeden beliebigen Teil der Datei anfordern, deshalb funktioniert Spulen.
- **Lückenlos (SetNextAVTransportURI):** Der Player erfährt den nächsten Song vorab, so entsteht keine Pause zwischen den Titeln.

## 4. Es sagt dir die Wahrheit über den Klang

Ein Hinweis im Player zeigt, was dein DAC wirklich bekommt: die Abtastrate, die Bittiefe und den Weg. `96 kHz / 24-bit · Exclusive` heißt zum Beispiel bit-perfect, und `44.1 → 48 kHz · Shared` heißt, der Computer rechnet die Abtastrate um. Wenn du den besten Weg wolltest und ihn nicht bekommst, steht auch das da, zum Beispiel wenn das Gerät kein externer DAC ist oder Plugins den Klang verändern. Raten musst du nie.

**Dahinter:**
- **Abtastrate (kHz):** wie oft pro Sekunde der Klang gemessen wird. CD: 44,1 kHz, Hi-Res: 96 oder 192 kHz.
- **Bittiefe:** wie fein jede Messung gespeichert ist. CD: 16 Bit, Hi-Res: 24 Bit.
- **Bit-perfect:** Der DAC bekommt genau die Zahlen aus der Datei, auf dem Weg wird nichts verändert.
- **Resampling:** das Umrechnen auf eine andere Abtastrate. Es passiert, wenn das System mit einer anderen Rate läuft als die Datei, und verändert das Signal leicht.
- **DAC (Digital-Analog-Wandler):** das Gerät, das aus den digitalen Zahlen den Klang für Verstärker oder Kopfhörer macht.

## 5. SACDs und DSD-Dateien, direkt abgespielt

DSF, DFF und sogar ganze SACD-Abbilder erscheinen als Titel in der Mediathek. Sie gehen direkt an einen DSD-DAC oder als sauberes PCM an einen DAC, der kein DSD kann. Dafür gibt es einen eigenen Pegel, damit sie nicht lauter oder leiser sind als deine übrige Musik.

**Dahinter:**
- **DSF / DFF:** die beiden Dateiformate für DSD-Musik.
- **SACD-ISO:** eine 1:1-Kopie einer ganzen Super Audio CD in einer Datei. Audio Harbor findet die Titel darin von selbst.
- **DST:** eine verlustfreie Kompression für DSD auf SACDs, ähnlich wie ZIP für Audio. Audio Harbor entpackt sie beim Abspielen.
- **DSD→PCM:** umgerechnet mit einem hochwertigen linearphasigen Filter, der das Timing so wenig wie möglich verändert, auf 88,2 kHz / 24 Bit.

## 6. Eine Fernbedienung ohne App und ohne Einrichtung

Öffne `audioharbor.local` auf einem Handy, Tablet oder Computer im selben Netzwerk, und du bist drin. Keine App installieren, kein Konto, kein Code. Leg sie auf den iPhone-Home-Bildschirm, dann sieht sie aus und fühlt sich an wie eine App, mit eigenem Symbol. Sie funktioniert weiter, wenn der Host eine neue Adresse bekommt, und verbindet sich von selbst neu, wenn das WLAN kurz weg ist. Wer lieber eine richtige App mag: Die Audio-Harbor-App für iOS findet den Host von allein.

**Dahinter:**
- **mDNS / Bonjour:** Damit sprechen sich Geräte mit Namen an statt mit IP-Adresse. Deshalb funktioniert `audioharbor.local` und funktioniert weiter, wenn der Router eine neue Adresse vergibt.
- **PWA (Progressive Web App):** eine Webseite, die sich wie eine App auf den Home-Bildschirm legen lässt, mit eigenem Symbol und Vollbild.
- **Service Worker:** ein kleiner Helfer im Browser, der die Dateien der Fernbedienung aufbewahrt, sodass sie schnell öffnet und eine neue Version erkennt.
- **WebSocket:** eine Verbindung, die offen bleibt, sodass der Host jede Änderung (Titel, Lautstärke, Position) sofort an die Fernbedienung schickt.
- **Bonjour-Dienst `_audioharbor._tcp`:** die Visitenkarte, nach der die iOS-App sucht, um den Host von selbst zu finden.

## 7. Ein Raspberry Pi, der läuft wie ein Gerät

Eine Zeile im Terminal installiert es, danach startet es beim Einschalten von selbst. Das Terminal brauchst du danach nie wieder:
- **Updates:** Einstellungen → Software-Update lädt die neue Version herunter, prüft sie und installiert sie.
- **Musik auf einem USB-Laufwerk oder einer Netzwerkfreigabe:** fügst du vom Handy aus hinzu.
- **Apple Lossless (ALAC):** spielt mit einem eigenen, eingebauten Decoder, der Pi braucht also kein großes zusätzliches Video-Paket.

Außerdem teilt es deine Mediathek mit anderen Geräten im Netzwerk, so versorgt ein Pi das ganze Haus.

**Dahinter:**
- **.deb-Paket:** das übliche Installationspaket von Debian und Raspberry Pi OS, installiert mit `apt`.
- **systemd:** der Teil von Linux, der Dienste beim Hochfahren startet und nach einem Absturz neu startet.
- **SHA-256-Prüfsumme:** ein Fingerabdruck des Downloads. Stimmt auch nur ein Byte nicht, wird das Update abgelehnt.
- **ALAC (Apple Lossless):** Apples verlustfreies Format in `.m4a`-Dateien. Audio Harbor nutzt Apples eigenen Open-Source-Decoder statt **ffmpeg**, ein riesiges Medien-Werkzeug, das fast 180 zusätzliche Pakete mitzieht.
- **DLNA-Medienserver (ContentDirectory):** Die Mediathek erscheint auf Fernsehern, Streamern und in anderen Apps, die darin stöbern und daraus abspielen können.

## 8. Eine Mediathek für jeden Raum

Leg deine Musik auf ein NAS oder gib sie von einem Host frei, dann spielt jedes Audio Harbor im Haus dieselbe Mediathek: ein Pi im Wohnzimmer, ein Mac im Arbeitszimmer, noch ein Pi in der Küche. Jedes Gerät bindet die Freigabe ein und fügt sie mit ein paar Fingertipps hinzu. DSD, SACD-Abbilder und alles andere spielen von der Freigabe genauso wie von einem lokalen Laufwerk.

**Dahinter:**
- **NAS (Network Attached Storage):** ein kleiner Speicher im Netzwerk, der Dateien für alle Geräte bereithält.
- **SMB / CIFS:** die Dateifreigabe-Sprache von Windows, die auch die meisten NAS und Macs sprechen. Unter Linux wird sie mit `cifs-utils` eingebunden.
- **Nur-Lese-Einbindung:** Die Freigabe wird so eingebunden, dass Audio Harbor sie lesen, aber nie etwas ändern oder löschen kann.
- **fstab mit Automount:** Die Freigabe kommt nach einem Neustart von selbst zurück, und der Pi hängt beim Hochfahren nicht, wenn das NAS aus ist.

## 9. Bit-perfect auf Mac, Linux und Windows

Ein Player, drei Systeme, dieselben Regeln. Im Exclusive-Modus nimmt Audio Harbor den DAC für sich allein, kein anderes Programm und kein Systemton wird dazugemischt, und der Klang kommt unverändert beim DAC an. Auf dem Mac stellt es den DAC außerdem auf die Abtastrate jeder Datei um. Kein verstecktes Umrechnen.

**Dahinter:**
- **Shared vs. Exclusive:** Bei *Shared* spielen alle Programme gleichzeitig und das System mischt sie, oft mit Resampling. Bei *Exclusive* hat Audio Harbor den DAC für sich allein.
- **Core Audio (Hog Mode):** das Audiosystem des Mac. *Hog Mode* ist Apples Name für „dieses Gerät gehört nur einem Programm".
- **ALSA (`hw:`-Gerät):** das Audiosystem von Linux. Ein `hw:`-Gerät geht direkt zur Hardware, an jedem Mixer vorbei.
- **WASAPI Exclusive:** dasselbe unter Windows: Das Programm spricht direkt mit dem DAC, am Windows-Mixer vorbei.

## 10. Eine Fernbedienung, die aussieht wie HiFi, nicht wie eine Tabelle

Der Player ist ein Plattenspieler oder eine Bandmaschine. Den Katalog öffnest du nach Ordnern, Alben, Künstlern oder Playlists, und die Suche bleibt oben, egal wo du bist. Er bewegt sich wie eine echte App: zurückwischen, weiche Übergänge, kein Warten auf Listen, die du schon gesehen hast. Am Computer steht die Warteschlange neben dem Player, wie in der Mac-App. Playlists und Labels teilt er mit der Audio-Harbor-App für iOS.

**Dahinter:**
- **View Transitions:** eine Browser-Funktion, die weich von einem Bildschirm zum nächsten gleitet und blendet, wie in einer iPhone-App.
- **Zwischenspeicher mit Auffrischen im Hintergrund:** Listen, die du schon geöffnet hattest, sind sofort da, und die Fernbedienung prüft dahinter leise auf Änderungen.
- **Vom Rand zurückwischen:** wie in iOS, auch in der App auf dem Home-Bildschirm.
- **Labels:** Schlagwörter für eigene Gruppen wie „Party" oder „Spätabends", quer durch Alben und Künstler.
