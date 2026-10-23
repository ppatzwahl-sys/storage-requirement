# ReactionX Trainer

Eigene Web App zur Steuerung der ReactionX Reaktionslampen (Modell FY-03 und baugleiche) per Bluetooth,
ausgerichtet auf kognitives Training im Handball.

## Funktionen

1. **Lampen verbinden** per Web Bluetooth, Akkustand anzeigen, Lampen testen und ausschalten
2. **Trainingsprogramme**
   1. Zufall: eine zufällige Lampe in einer zufälligen Farbe
   2. Go / NoGo: Zielfarben treffen, Störfarben ignorieren (Hemmung und Entscheidung)
   3. Reihenfolge: Lampen der Reihe nach
   4. Duell: 2 bis 4 Farben, jede Farbe ist ein Team, wer mehr trifft gewinnt
   5. Sprint: Startlampe abschlagen, zur Ziellampe (fest oder zufällig) laufen, Zeit dazwischen wird gemessen
   6. Immer mehr: Lampen gehen in festem oder immer kürzerem Abstand an, sind alle gleichzeitig an, ist das Spiel vorbei
   7. Basis: eine feste Basislampe leuchtet, nach dem Abschlagen leuchtet eine der anderen, dann wieder die Basis. Gemessen werden Reaktion am Ziel und Rückweg zur Basis
3. **Reaktionszeiten** werden von der Lampe selbst gemessen (10 ms Auflösung)
4. **Ergebnisse** pro Spieler speichern und als CSV für Excel exportieren
5. **Simulationsmodus** mit virtuellen Lampen zum Ausprobieren ohne Hardware
6. **Diagnose** zum Senden roher Befehle

## Benutzung

Web Bluetooth braucht HTTPS und einen passenden Browser:

| Gerät | Browser |
|---|---|
| Android | Chrome |
| Windows, macOS, ChromeOS, Linux | Chrome oder Edge |
| iPhone, iPad | App „Bluefy“ (Safari kann kein Web Bluetooth) |

Am einfachsten über GitHub Pages veröffentlichen: im Repository unter Settings, Pages den Branch auswählen.
Danach ist die App unter `https://<nutzer>.github.io/<repo>/` erreichbar und lässt sich zum Startbildschirm hinzufügen.

Lokal testen: `python3 -m http.server` im Ordner starten und `http://localhost:8000` öffnen
(localhost gilt als sicher, Bluetooth funktioniert dort ebenfalls).

**Wichtig:** Die offizielle ReactionX App vorher schließen, eine Lampe kann nur mit einem Gerät verbunden sein.

## Automatisch verbinden (Chrome auf Android)

Jede Lampe einmal über „Lampe verbinden“ koppeln. Danach verbindet „Alle verbinden“ (oder die Einstellung
„Beim Start automatisch verbinden“) alle bekannten Lampen in Reichweite ohne Auswahlfenster.

Dafür muss Chrome sich die Lampen merken dürfen. Ist das noch nicht aktiv, zeigt die App eine Anleitung:
in `chrome://flags` „Web Bluetooth New Permissions Backend“ und „Experimental Web Platform features“ auf
Enabled stellen und Chrome neu starten.

## Neue Version veröffentlichen

In `index.html` die Versionsnummer an drei Stellen erhöhen: `<meta name="app-version">`, `style.css?v=` und
`app.js?v=`. Geöffnete Apps zeigen dann den Hinweis „Neue Version verfügbar“.

## Protokoll

Siehe [PROTOKOLL.md](PROTOKOLL.md).
