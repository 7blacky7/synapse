"""P18-T97: verlustfreie GFX-Dekodierung; ausschließlich begrenzte Quelldaten.
Fachbeleg: @ref rev-die-siedler-3-229a52 / 3ae70584@v1, d3d355d5.
Keine Spieltabellen, Vorschauen, Projektzugriffe oder Fremdmodule.
"""
from __future__ import annotations

import struct
import zlib


class Dekodiergrenze(ValueError):
    """Record bleibt offen; niemals als unbekannte Variante überspringen."""


class UnbekannteVariante(ValueError):
    """Rohbeleg bleibt bei einer semantisch unbekannten Variante erhalten."""


GRUPPEN = {0x106: "sprite", 0x3112: "torso", 0x5982: "shadow",
           0x11306: "gui", 0x2412: "landscape"}
MASKEN = ((0xf800, 0x7e0, 0x1f), (0x7c00, 0x3e0, 0x1f))


def dekodiere(quelle, offset, ende, gruppentyp):
    """Liefert PNG, tatsächlich verbrauchte Quellbytes und verlustfreie Metadaten."""
    quelle.check()
    art = GRUPPEN.get(gruppentyp)
    if art is None:
        raise UnbekannteVariante("variante_unbekannt")
    versetzt = art in ("sprite", "torso", "shadow")
    kopf = 12 if versetzt else 8 if art == "gui" else 6
    if offset + kopf > ende:
        raise ValueError("bildrecord_zu_kurz")
    head = quelle.read(offset, kopf)
    if versetzt and head[:4] != b"\x0c\0\0\0":
        raise UnbekannteVariante("bildheader_unbekannt")
    width, height = struct.unpack_from("<HH", head, 4 if versetzt else 0)
    dx, dy = struct.unpack_from("<hh", head, 8) if versetzt else (0, 0)
    masks = struct.unpack("<III", quelle.read(32, 12))
    if masks not in MASKEN:
        raise UnbekannteVariante("rgb_masken_unbekannt_roh_erhalten")
    if width == height == 0:
        raise UnbekannteVariante("legitimer_nullframe")
    if not width or not height:
        raise UnbekannteVariante("dimension_ungueltig_roh_erhalten")
    limits = quelle.limits
    pixelbytes = width * height * 4
    rowbytes = width * 4 + 1
    # Reserve für Pixel, PNG-Teile/Join, zlib und begrenzte Quellblöcke.
    # Keine eigene absolute Grenze: ausschließlich die übergebene PG-Projektion.
    if pixelbytes * 8 + rowbytes * 2 + quelle.chunk * 2 > limits["ram_mib"] * 1048576:
        raise Dekodiergrenze("speicherlimit_bild")
    if pixelbytes + height > limits["bytes"]:
        raise Dekodiergrenze("schrittgrenze_bild")
    pixels = bytearray(pixelbytes)
    pos = offset + kopf
    pos += pos % 2

    def take(n):
        nonlocal pos
        quelle.check()
        if pos + n > ende:
            raise ValueError("rle_recordgrenze")
        data = quelle.read(pos, n)
        pos += n
        return data

    shifts = [(mask & -mask).bit_length() - 1 for mask in masks]
    for y in range(height):
        quelle.check()
        x = 0
        while True:
            control = int.from_bytes(take(2), "little")
            count, skip = control & 255, (control >> 8) & 127
            x += skip
            if x + count > width:
                raise ValueError("rle_bildbreite")
            for _ in range(count):
                if art == "shadow":
                    color = (0, 0, 0, 128)
                elif art == "torso":
                    value = (take(1)[0] & 31) * 255 // 31
                    color = (value, value, value, 255)
                else:
                    value = int.from_bytes(take(2), "little")
                    color = tuple(((value & m) >> s) * 255 // (m >> s)
                                  for m, s in zip(masks, shifts)) + (255,)
                at = (y * width + x) * 4
                pixels[at:at + 4] = bytes(color)
                x += 1
            if control & 0x8000:
                break

    # Legacy: dieselben Filter-0-Zeilen in EINEM zlib-Aufruf. Fragmentiertes
    # compressobj-Zufüttern kann bei identischen Pixeln andere Deflate-Bits liefern.
    # Der RAM-Preflight oben reserviert bereits beide ungepackten Bildpuffer.
    rows = bytearray(pixelbytes + height)
    for y in range(height):
        quelle.check()
        at = y * rowbytes
        # bytearray ist nullinitialisiert: Filterbyte bleibt 0.
        rows[at + 1:at + rowbytes] = pixels[y * width * 4:(y + 1) * width * 4]
    quelle.check()
    compressed = zlib.compress(rows, level=zlib.Z_DEFAULT_COMPRESSION)
    quelle.check()
    max_png = min(limits["datei_bytes"], limits["bytes"], limits["ram_mib"] * 1048576 // 8)
    if len(compressed) + 57 > max_png:
        raise Dekodiergrenze("png_dateigrenze")

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data)))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", compressed) + chunk(b"IEND", b""))
    quelle.check()
    return png, pos - offset, {
        "breite": str(width), "hoehe": str(height),
        "versatz_x": str(dx), "versatz_y": str(dy),
        "darstellung": "graustufenmaske" if art == "torso" else art,
        "rgb_masken": [str(v) for v in masks],
    }
