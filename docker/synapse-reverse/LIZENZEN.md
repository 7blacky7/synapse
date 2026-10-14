# Lizenzen der eigenständigen Image-Werkzeuge

| Werkzeug | Lizenz | Version / Quelle |
|---|---|---|
| 7-Zip | LGPL-2.1-or-later mit unRAR-Klausel; hier nur Entpacken | Debian 7zip 25.01 |
| libarchive / bsdtar | BSD-2-Clause | Debian trixie |
| libMirage | GPL-2.0-or-later | libmirage11 3.2.x + gir1.2-mirage-3.2; P18-T49: als eigenständiges Werkzeug im Container über GObject-Introspection geladen (Parser-Prozess je Auftrag), nicht in Synapse-Code eingebunden oder weitergegeben |
| PyGObject (python3-gi) | LGPL-2.1-or-later | Debian trixie |
| bchunk | GPL-2.0-or-later | Debian trixie |
| unshield | MIT | Debian trixie |
| innoextract | zlib | Debian trixie |
| msitools / msiextract | LGPL-2.1-or-later | Debian trixie |
| cabextract | GPL-3.0-or-later | Debian trixie |
| unar, lhasa, arj | GPL | Debian trixie |
| mtools | GPL-3.0-or-later | Debian trixie |
| mscompress / msexpand | GPL-2.0-or-later | Debian trixie; Microsoft SZDD/KWAJ decompression |
| file / libmagic | BSD-2-Clause | Debian trixie |
| LLVM llvm-readobj | Apache-2.0 WITH LLVM-exception | Debian trixie |
| Rizin / rz-bin | LGPL-3.0-or-later | Official rizinorg/rizin static release v0.9.1; SHA-256 9102249a9f0b6319c5334a2e5cf8d9cc3f2035e1d3def027c41f6a90f647e8cf |
| FFmpeg | LGPL-2.1-or-later or GPL-2.0-or-later, depending on package build | Debian ffmpeg 7.1.5 |
| OpenJDK 21 | GPL-2.0-or-later WITH Classpath-exception-2.0 | Debian trixie main snapshot |
| Ghidra | Apache-2.0 | Official NSA release 11.4.3; SHA-256 b22a8baebb14339f19903c54363ba7e01781930cc43ab430539aabce0d58547a |

Debian copyright texts are retained in /usr/share/doc/<package>/copyright in the image. Ghidra's upstream LICENSE is in /opt/ghidra. The runner and Ghidra export script are new Synapse files. No third-party source is copied into them.

Die Paketliste wird gegen den datierten Debian-Snapshot gebaut. FFmpeg-Codecs hängen von der Debian-Buildkonfiguration ab; für eine Lizenzänderung muss die Paketkonfiguration geprüft und diese Liste aktualisiert werden.
