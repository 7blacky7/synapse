# Ansicht-Dienst (P13-T32)

Die vorhandene API-Alpine-Basis erhält Pakete ausschließlich aus ihrer offiziellen Distribution. Es gibt keine Downloads zur Laufzeit.

| Paket | Lizenz | Verwendung |
| --- | --- | --- |
| FFmpeg / FFprobe | LGPL-2.1-or-later oder GPL-2.0-or-later gemäß Distributions-Build | Rasterbilder und Video-Standbilder |
| util-linux / prlimit | GPL-2.0-or-later | Harte Adressraum-/CPU-Grenzen der Decoderprozesse |

Codec-Unterstützung hängt vom installierten Build ab. Nicht vorhandene Decoder ergeben `ansicht_nicht_darstellbar`; Header-Erkennung allein gilt nicht als Renderer. Der Image-Build installiert die Distributionsversion. Bei Deploy die Paketversionen im Image erfassen.
