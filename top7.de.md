# Audio Harbor Headless — 7 Dinge, die die meisten Player nicht können

*[English](top7.md)*

## 1. Deine eigenen Studio-Plugins, gesteuert vom Handy

EQ, Raumkorrektur, Limiter: Audio Harbor nutzt die Plugins, die du schon hast (CLAP, VST3, AU auf dem Mac, LV2 unter Linux), auf einem Gerät ohne Bildschirm. Die Regler bedienst du auf dem iPhone. Fünf gute Plugins sind kostenlos dabei, und die EQs haben richtige Oberflächen, auf denen du die Kurve mit dem Finger ziehst. Eine Taste schaltet alle Plugins ohne Unterbrechung aus und wieder ein, so hörst du den Unterschied sofort (A/B). Stürzt ein Plugin ab, läuft die Musik weiter, nur ohne den Effekt, und das Rack kommt von selbst zurück.

## 2. DSD an einen Netzwerk-Streamer, Bits unverändert

Die meisten Player machen aus DSD normales PCM, bevor es übers Netzwerk geht. Audio Harbor kann die DSD-Bits in den Stream verpacken (DoP), sodass ein DSD-DAC hinter deinem Streamer das originale DSD bekommt. Bricht DSD im WLAN ab, schickt ein Schalter stattdessen einen leichteren Stream.

## 3. Jeder Netzwerk-Player wird wie ein Kabel zum DAC

Ein Streamer, ein Verstärker, ein Fernseher oder eine Soundbar im Heimnetz wird zu einem Ausgang, genau wie ein DAC am Kabel. Kann der Player die Datei abspielen, bekommt er sie so, wie sie ist. Kann er es nicht, bekommt er eine verlustfreie Kopie, die beim Abspielen entsteht. Spulen funktioniert, Songs gehen lückenlos ineinander über, wenn der Player das kann, und du kannst die Musik zwischen dem Host und dem Netzwerk-Player hin- und herschieben, ohne die Stelle im Song zu verlieren.

## 4. Es sagt dir die Wahrheit über den Klang

Ein Hinweis im Player zeigt, was dein DAC wirklich bekommt: die Abtastrate, die Bittiefe und den Weg. `96 kHz / 24-bit · Exclusive` heißt zum Beispiel bit-perfect, und `44.1 → 48 kHz · Shared` heißt, der Computer rechnet die Abtastrate um. Wenn du den besten Weg wolltest und ihn nicht bekommst, steht auch das da, zum Beispiel wenn das Gerät kein externer DAC ist oder Plugins den Klang verändern. Raten musst du nie.

## 5. SACDs und DSD-Dateien, direkt abgespielt

DSF, DFF und sogar ganze SACD-Abbilder (ISO, auch die komprimierte DST-Art) erscheinen als Titel in der Mediathek. Sie gehen direkt an einen DSD-DAC (DoP) oder als sauberes PCM an einen DAC, der kein DSD kann. Dafür gibt es einen eigenen Pegel, damit sie nicht lauter oder leiser sind als deine übrige Musik.

## 6. Eine Fernbedienung ohne App und ohne Einrichtung

Öffne `audioharbor.local` auf einem Handy, Tablet oder Computer im selben Netzwerk, und du bist drin. Keine App installieren, kein Konto, kein Code. Leg sie auf den iPhone-Home-Bildschirm, dann sieht sie aus und fühlt sich an wie eine App, mit eigenem Symbol. Sie funktioniert weiter, wenn der Host eine neue Adresse bekommt, und verbindet sich von selbst neu, wenn das WLAN kurz weg ist. Wer lieber eine richtige App mag: Die Audio-Harbor-App für iOS findet den Host von allein.

## 7. Ein Raspberry Pi, der läuft wie ein Gerät

Eine Zeile im Terminal installiert es, danach startet es beim Einschalten von selbst. Das Terminal brauchst du danach nie wieder:
- **Updates:** Einstellungen → Software-Update lädt die neue Version herunter, prüft sie und installiert sie.
- **Musik auf einem USB-Laufwerk oder einer Netzwerkfreigabe:** fügst du vom Handy aus hinzu.
- **Apple Lossless (ALAC):** spielt mit einem eigenen, eingebauten Decoder, der Pi braucht also kein großes zusätzliches Video-Paket (ffmpeg).

Außerdem teilt es deine Mediathek mit anderen Geräten im Netzwerk (DLNA), so versorgt ein Pi das ganze Haus.
