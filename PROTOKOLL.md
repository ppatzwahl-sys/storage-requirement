# ReactionX Bluetooth Protokoll

Ermittelt durch Analyse der offiziellen App `com.queling.reactionx` Version 3.7
(React Native, Hermes Bytecode, Bibliothek `react-native-ble-manager`).
Ziel ist die Interoperabilität mit den eigenen Lampen.

## Verbindung

| Eigenschaft | Wert |
|---|---|
| Gerätename | `$react-N` (N = Lampennummer 1 bis 12), Variante X-Ball: `$xball-N` |
| Service | Nordic UART `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| Schreiben (App an Lampe) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`, write without response |
| Benachrichtigung (Lampe an App) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`, notify |

## Befehle App an Lampe

| Bytes | Bedeutung |
|---|---|
| `02 B1 B2 B3 TL TH` | Licht einschalten und Sensor scharf schalten |
| `02 B1` | Licht einschalten, kompakte Form für ältere Lampen (ProductVersion 3) |
| `04 B1` | Nur Licht, ohne Treffererkennung |
| `05` | Licht aus |
| `20` | Akkustand und Version abfragen |
| `88` | Lampe ausschalten |

### Byte B1 (Farbe und Optionen)

| Bits | Bedeutung |
|---|---|
| 0 bis 2 | Farbe: 1 Rot, 2 Grün, 3 Gelb, 4 Blau, 5 Lila, 6 Cyan, 7 Weiß |
| 3 (`0x08`) | Signalton beim Aufleuchten |
| 4 (`0x10`) | Signalton bei Treffer |
| 5 (`0x20`) | Blinken aktiv |
| 6 bis 7 | Sensor: `0x40` nah, `0x80` fern, `0xC0` Vibration |

### Byte B2 (Erweiterung)

| Wert | Bedeutung |
|---|---|
| `0x10` | Verstärkter Sensor (mit `0x40` in B1: starke Vibration, mit `0x80`: fern plus) |
| `0x02` | Sonderfarbe (Farbcode 8 der App) |

### Byte B3 (Blinkfrequenz)

Periode in Zehntelsekunden: `0` einmal, `10` = 1 Hz, `5` = 2 Hz, `2` = 5 Hz, `1` = 10 Hz.

### TL TH (Zeitlimit)

Little Endian, Einheit 10 ms. `0` bedeutet kein Zeitlimit. Beispiel 2 s = 200 = `C8 00`.

## Meldungen Lampe an App

| Bytes | Bedeutung |
|---|---|
| `03 xx TL TH` | Treffer. Reaktionszeit = (TL + TH × 256) / 100 Sekunden, von der Lampe gemessen |
| `09` | Zeitlimit abgelaufen, Lampe ist aus |
| `21 V BL BH` | Akku: Spannung = (BL + BH × 256) × 10 mV. V > 128 bedeutet Hardware Version 4 |

Akkubewertung der offiziellen App: über 3,90 V voll, über 3,65 V gut, über 3,40 V mittel, sonst schwach.
