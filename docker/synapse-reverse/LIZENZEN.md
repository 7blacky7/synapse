# Lizenzen der eigenständigen Image-Werkzeuge

| Werkzeug | Lizenz | Version / Quelle |
|---|---|---|
| 7-Zip | LGPL-2.1-or-later mit unRAR-Klausel; hier nur Entpacken | Debian 7zip 25.01 |
| libarchive / bsdtar | BSD-2-Clause | Debian trixie |
| libMirage | GPL-2.0-or-later | libmirage11, GObject-Introspection |
| bchunk | GPL-2.0-or-later | Debian trixie |
| unshield | MIT | Debian trixie |
| innoextract | zlib | Debian trixie |
| msitools / msiextract | LGPL-2.1-or-later | Debian trixie |
| cabextract | GPL-3.0-or-later | Debian trixie |
| unar, lhasa, arj | GPL | Debian trixie |
| mtools | GPL-3.0-or-later | Debian trixie |
| file / libmagic | BSD-2-Clause | Debian trixie |
| LLVM llvm-readobj | Apache-2.0 WITH LLVM-exception | Debian trixie |
| Rizin / rz-bin | LGPL-3.0-or-later | Debian trixie |
| FFmpeg | LGPL-2.1-or-later or GPL-2.0-or-later, depending on package build | Debian ffmpeg 7.1.5 |
| OpenJDK | GPL-2.0-or-later WITH Classpath-exception-2.0 | Debian trixie |
| Ghidra | Apache-2.0 | Official NSA release 12.1.3; SHA-256 93a5d11a9ad510622acaaf908c556a7b9b764d338e78a7567f3689bf5081fd54 |

Debian copyright texts are retained in /usr/share/doc/<package>/copyright in the image. Ghidra's upstream LICENSE is in /opt/ghidra. The runner and Ghidra export script are new Synapse files. No third-party source is copied into them.

Die Paketliste wird gegen den datierten Debian-Snapshot gebaut. FFmpeg-Codecs hängen von der Debian-Buildkonfiguration ab; für eine Lizenzänderung muss die Paketkonfiguration geprüft und diese Liste aktualisiert werden.
