/**
 * MODUL: Textur-Formattabellen
 * ZWECK: Klartextnamen und Groessen fuer DXGI-, D3D/FourCC-, OpenGL- und Vulkan-Formate (P4-T64).
 *        Es steht der Klartext (BC7, RGBA16F, ...) in metadata; die Rohkennung (DXGI-Name, GL-Enum,
 *        VkFormat-Nummer) bleibt in format_specific.
 *
 * Die Tabellen decken die gaengigen BCn-/ETC2-/ASTC- und RGBA-Formate ab. Unbekannte Kennungen
 * liefern null (kein Raten); der Aufrufer meldet dann die Rohzahl.
 */

/** Eigenschaften eines Pixel-/Blockformats. */
export interface FormatInfo {
  /** Klartextname, z. B. 'BC7', 'RGBA16F'. */
  name: string;
  /** Blockbreite in Texeln (unkomprimiert 1). */
  bw: number;
  /** Blockhoehe in Texeln (unkomprimiert 1). */
  bh: number;
  /** Bits je Block (unkomprimiert: Bits je Pixel). */
  bits: number;
  /** Kanalzahl; null wenn nicht eindeutig. */
  ch: number | null;
  /** Bits je Kanal; null bei komprimierten/gepackten Formaten. */
  bpc: number | null;
  /** Alpha vorhanden; null wenn das Format es offen laesst (z. B. BC1). */
  alpha: boolean | null;
  /** sRGB-kodiert. */
  srgb: boolean;
  /** Blockkomprimiert. */
  komprimiert: boolean;
}

function unc(name: string, bpp: number, ch: number | null, bpc: number | null, alpha: boolean | null, srgb = false): FormatInfo {
  return { name, bw: 1, bh: 1, bits: bpp, ch, bpc, alpha, srgb, komprimiert: false };
}

function blk(name: string, bw: number, bh: number, bytes: number, ch: number | null, alpha: boolean | null, srgb = false, bpc: number | null = null): FormatInfo {
  return { name, bw, bh, bits: bytes * 8, ch, bpc, alpha, srgb, komprimiert: true };
}

/** DXGI_FORMAT-Namen nach Index 0..99. */
const DXGI_LISTE =
  'UNKNOWN R32G32B32A32_TYPELESS R32G32B32A32_FLOAT R32G32B32A32_UINT R32G32B32A32_SINT R32G32B32_TYPELESS R32G32B32_FLOAT R32G32B32_UINT R32G32B32_SINT R16G16B16A16_TYPELESS R16G16B16A16_FLOAT R16G16B16A16_UNORM R16G16B16A16_UINT R16G16B16A16_SNORM R16G16B16A16_SINT R32G32_TYPELESS R32G32_FLOAT R32G32_UINT R32G32_SINT R32G8X24_TYPELESS D32_FLOAT_S8X24_UINT R32_FLOAT_X8X24_TYPELESS X32_TYPELESS_G8X24_UINT R10G10B10A2_TYPELESS R10G10B10A2_UNORM R10G10B10A2_UINT R11G11B10_FLOAT R8G8B8A8_TYPELESS R8G8B8A8_UNORM R8G8B8A8_UNORM_SRGB R8G8B8A8_UINT R8G8B8A8_SNORM R8G8B8A8_SINT R16G16_TYPELESS R16G16_FLOAT R16G16_UNORM R16G16_UINT R16G16_SNORM R16G16_SINT R32_TYPELESS D32_FLOAT R32_FLOAT R32_UINT R32_SINT R24G8_TYPELESS D24_UNORM_S8_UINT R24_UNORM_X8_TYPELESS X24_TYPELESS_G8_UINT R8G8_TYPELESS R8G8_UNORM R8G8_UINT R8G8_SNORM R8G8_SINT R16_TYPELESS R16_FLOAT D16_UNORM R16_UNORM R16_UINT R16_SNORM R16_SINT R8_TYPELESS R8_UNORM R8_UINT R8_SNORM R8_SINT A8_UNORM R1_UNORM R9G9B9E5_SHAREDEXP R8G8_B8G8_UNORM G8R8_G8B8_UNORM BC1_TYPELESS BC1_UNORM BC1_UNORM_SRGB BC2_TYPELESS BC2_UNORM BC2_UNORM_SRGB BC3_TYPELESS BC3_UNORM BC3_UNORM_SRGB BC4_TYPELESS BC4_UNORM BC4_SNORM BC5_TYPELESS BC5_UNORM BC5_SNORM B5G6R5_UNORM B5G5R5A1_UNORM B8G8R8A8_UNORM B8G8R8X8_UNORM R10G10B10_XR_BIAS_A2_UNORM B8G8R8A8_TYPELESS B8G8R8A8_UNORM_SRGB B8G8R8X8_TYPELESS B8G8R8X8_UNORM_SRGB BC6H_TYPELESS BC6H_UF16 BC6H_SF16 BC7_TYPELESS BC7_UNORM BC7_UNORM_SRGB'.split(
    ' '
  );

/** Rohname eines DXGI_FORMAT (z. B. 'BC7_UNORM'); unbekannte Werte werden zu 'DXGI_<n>'. */
export function dxgiRohname(id: number): string {
  if (id === 115) return 'B4G4R4A4_UNORM';
  return DXGI_LISTE[id] ?? `DXGI_${id}`;
}

/** DXGI-Formate mit bekannter Groesse (id -> Eigenschaften). */
export const DXGI: Record<number, FormatInfo> = {
  2: unc('RGBA32F', 128, 4, 32, true),
  3: unc('RGBA32U', 128, 4, 32, true),
  4: unc('RGBA32I', 128, 4, 32, true),
  6: unc('RGB32F', 96, 3, 32, false),
  10: unc('RGBA16F', 64, 4, 16, true),
  11: unc('RGBA16', 64, 4, 16, true),
  12: unc('RGBA16U', 64, 4, 16, true),
  13: unc('RGBA16S', 64, 4, 16, true),
  14: unc('RGBA16I', 64, 4, 16, true),
  16: unc('RG32F', 64, 2, 32, false),
  24: unc('RGB10A2', 32, 4, null, true),
  26: unc('R11G11B10F', 32, 3, null, false),
  28: unc('RGBA8', 32, 4, 8, true),
  29: unc('RGBA8 sRGB', 32, 4, 8, true, true),
  30: unc('RGBA8U', 32, 4, 8, true),
  31: unc('RGBA8S', 32, 4, 8, true),
  34: unc('RG16F', 32, 2, 16, false),
  35: unc('RG16', 32, 2, 16, false),
  41: unc('R32F', 32, 1, 32, false),
  49: unc('RG8', 16, 2, 8, false),
  54: unc('R16F', 16, 1, 16, false),
  56: unc('R16', 16, 1, 16, false),
  61: unc('R8', 8, 1, 8, false),
  65: unc('A8', 8, 1, 8, true),
  67: unc('RGB9E5', 32, 3, null, false),
  71: blk('BC1', 4, 4, 8, 3, null),
  72: blk('BC1 sRGB', 4, 4, 8, 3, null, true),
  74: blk('BC2', 4, 4, 16, 4, true),
  75: blk('BC2 sRGB', 4, 4, 16, 4, true, true),
  77: blk('BC3', 4, 4, 16, 4, true),
  78: blk('BC3 sRGB', 4, 4, 16, 4, true, true),
  80: blk('BC4', 4, 4, 8, 1, false),
  81: blk('BC4 signed', 4, 4, 8, 1, false),
  83: blk('BC5', 4, 4, 16, 2, false),
  84: blk('BC5 signed', 4, 4, 16, 2, false),
  85: unc('B5G6R5', 16, 3, null, false),
  86: unc('B5G5R5A1', 16, 4, null, true),
  87: unc('BGRA8', 32, 4, 8, true),
  88: unc('BGRX8', 32, 3, 8, false),
  91: unc('BGRA8 sRGB', 32, 4, 8, true, true),
  93: unc('BGRX8 sRGB', 32, 3, 8, false, true),
  95: blk('BC6H', 4, 4, 16, 3, false, false, 16),
  96: blk('BC6H signed', 4, 4, 16, 3, false, false, 16),
  98: blk('BC7', 4, 4, 16, 4, null),
  99: blk('BC7 sRGB', 4, 4, 16, 4, null, true),
  115: unc('B4G4R4A4', 16, 4, 4, true),
};

/** D3D9-FourCCs (Text) und numerische D3DFMT-Werte ('#113') im DDS-Pixelformat. */
export const FOURCC: Record<string, FormatInfo> = {
  DXT1: blk('BC1', 4, 4, 8, 3, null),
  DXT2: blk('BC2 (premultiplied)', 4, 4, 16, 4, true),
  DXT3: blk('BC2', 4, 4, 16, 4, true),
  DXT4: blk('BC3 (premultiplied)', 4, 4, 16, 4, true),
  DXT5: blk('BC3', 4, 4, 16, 4, true),
  ATI1: blk('BC4', 4, 4, 8, 1, false),
  BC4U: blk('BC4', 4, 4, 8, 1, false),
  BC4S: blk('BC4 signed', 4, 4, 8, 1, false),
  ATI2: blk('BC5', 4, 4, 16, 2, false),
  BC5U: blk('BC5', 4, 4, 16, 2, false),
  BC5S: blk('BC5 signed', 4, 4, 16, 2, false),
  '#36': unc('RGBA16', 64, 4, 16, true),
  '#110': unc('RGBA16S', 64, 4, 16, true),
  '#111': unc('R16F', 16, 1, 16, false),
  '#112': unc('RG16F', 32, 2, 16, false),
  '#113': unc('RGBA16F', 64, 4, 16, true),
  '#114': unc('R32F', 32, 1, 32, false),
  '#115': unc('RG32F', 64, 2, 32, false),
  '#116': unc('RGBA32F', 128, 4, 32, true),
};

/** ASTC-Blockgroessen in Reihenfolge der GL-/Vulkan-Enums. */
const ASTC_BLOECKE: Array<[number, number]> = [
  [4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12],
];

/** OpenGL-Internalformate (KTX 1.1). Schluessel: glInternalFormat. */
export const GL_INTERN: Record<number, FormatInfo> = (() => {
  const t: Record<number, FormatInfo> = {
    0x83f0: blk('BC1', 4, 4, 8, 3, false),
    0x83f1: blk('BC1', 4, 4, 8, 4, null),
    0x83f2: blk('BC2', 4, 4, 16, 4, true),
    0x83f3: blk('BC3', 4, 4, 16, 4, true),
    0x8c4c: blk('BC1 sRGB', 4, 4, 8, 3, false, true),
    0x8c4d: blk('BC1 sRGB', 4, 4, 8, 4, null, true),
    0x8c4e: blk('BC2 sRGB', 4, 4, 16, 4, true, true),
    0x8c4f: blk('BC3 sRGB', 4, 4, 16, 4, true, true),
    0x8dbb: blk('BC4', 4, 4, 8, 1, false),
    0x8dbc: blk('BC4 signed', 4, 4, 8, 1, false),
    0x8dbd: blk('BC5', 4, 4, 16, 2, false),
    0x8dbe: blk('BC5 signed', 4, 4, 16, 2, false),
    0x8e8c: blk('BC7', 4, 4, 16, 4, null),
    0x8e8d: blk('BC7 sRGB', 4, 4, 16, 4, null, true),
    0x8e8e: blk('BC6H signed', 4, 4, 16, 3, false, false, 16),
    0x8e8f: blk('BC6H', 4, 4, 16, 3, false, false, 16),
    0x8d64: blk('ETC1', 4, 4, 8, 3, false),
    0x9270: blk('EAC R11', 4, 4, 8, 1, false),
    0x9271: blk('EAC R11 signed', 4, 4, 8, 1, false),
    0x9272: blk('EAC RG11', 4, 4, 16, 2, false),
    0x9273: blk('EAC RG11 signed', 4, 4, 16, 2, false),
    0x9274: blk('ETC2 RGB8', 4, 4, 8, 3, false),
    0x9275: blk('ETC2 RGB8 sRGB', 4, 4, 8, 3, false, true),
    0x9276: blk('ETC2 RGB8A1', 4, 4, 8, 4, true),
    0x9277: blk('ETC2 RGB8A1 sRGB', 4, 4, 8, 4, true, true),
    0x9278: blk('ETC2 RGBA8', 4, 4, 16, 4, true),
    0x9279: blk('ETC2 RGBA8 sRGB', 4, 4, 16, 4, true, true),
    0x8058: unc('RGBA8', 32, 4, 8, true),
    0x8c43: unc('RGBA8 sRGB', 32, 4, 8, true, true),
    0x8051: unc('RGB8', 24, 3, 8, false),
    0x8c41: unc('RGB8 sRGB', 24, 3, 8, false, true),
    0x8229: unc('R8', 8, 1, 8, false),
    0x822b: unc('RG8', 16, 2, 8, false),
    0x822d: unc('R16F', 16, 1, 16, false),
    0x822e: unc('R32F', 32, 1, 32, false),
    0x822f: unc('RG16F', 32, 2, 16, false),
    0x8230: unc('RG32F', 64, 2, 32, false),
    0x805b: unc('RGBA16', 64, 4, 16, true),
    0x881a: unc('RGBA16F', 64, 4, 16, true),
    0x881b: unc('RGB16F', 48, 3, 16, false),
    0x8814: unc('RGBA32F', 128, 4, 32, true),
    0x8815: unc('RGB32F', 96, 3, 32, false),
    0x8d62: unc('RGB565', 16, 3, null, false),
    0x8057: unc('RGB5A1', 16, 4, null, true),
    0x8056: unc('RGBA4', 16, 4, 4, true),
    0x8059: unc('RGB10A2', 32, 4, null, true),
    0x8c3a: unc('R11G11B10F', 32, 3, null, false),
    0x8c3d: unc('RGB9E5', 32, 3, null, false),
  };
  ASTC_BLOECKE.forEach(([bw, bh], i) => {
    t[0x93b0 + i] = blk(`ASTC ${bw}x${bh}`, bw, bh, 16, 4, null);
    t[0x93d0 + i] = blk(`ASTC ${bw}x${bh} sRGB`, bw, bh, 16, 4, null, true);
  });
  return t;
})();

/** Roher GL-Name zu einem Internalformat (nur fuer die wichtigsten; sonst Hexzahl). */
export function glRohname(id: number): string {
  return '0x' + id.toString(16).padStart(4, '0');
}

/** glFormat -> Name. */
export const GL_FORMAT: Record<number, string> = {
  0x1903: 'RED', 0x8227: 'RG', 0x1907: 'RGB', 0x1908: 'RGBA', 0x80e0: 'BGR', 0x80e1: 'BGRA', 0x1909: 'LUMINANCE', 0x190a: 'LUMINANCE_ALPHA', 0x1902: 'DEPTH_COMPONENT',
};

/** glType -> Name. */
export const GL_TYP: Record<number, string> = {
  0x1400: 'BYTE', 0x1401: 'UNSIGNED_BYTE', 0x1402: 'SHORT', 0x1403: 'UNSIGNED_SHORT', 0x1404: 'INT', 0x1405: 'UNSIGNED_INT', 0x1406: 'FLOAT', 0x140b: 'HALF_FLOAT', 0x8363: 'UNSIGNED_SHORT_5_6_5', 0x8033: 'UNSIGNED_SHORT_4_4_4_4', 0x8034: 'UNSIGNED_SHORT_5_5_5_1', 0x8368: 'UNSIGNED_INT_5_9_9_9_REV', 0x8c3b: 'UNSIGNED_INT_10F_11F_11F_REV',
};

/** VkFormat (KTX2). Schluessel: Zahlenwert aus vkFormat. */
export const VK: Record<number, FormatInfo> = (() => {
  const t: Record<number, FormatInfo> = {
    9: unc('R8', 8, 1, 8, false),
    15: unc('R8 sRGB', 8, 1, 8, false, true),
    16: unc('RG8', 16, 2, 8, false),
    22: unc('RG8 sRGB', 16, 2, 8, false, true),
    23: unc('RGB8', 24, 3, 8, false),
    29: unc('RGB8 sRGB', 24, 3, 8, false, true),
    30: unc('BGR8', 24, 3, 8, false),
    36: unc('BGR8 sRGB', 24, 3, 8, false, true),
    37: unc('RGBA8', 32, 4, 8, true),
    43: unc('RGBA8 sRGB', 32, 4, 8, true, true),
    44: unc('BGRA8', 32, 4, 8, true),
    50: unc('BGRA8 sRGB', 32, 4, 8, true, true),
    64: unc('RGB10A2', 32, 4, null, true),
    70: unc('R16', 16, 1, 16, false),
    76: unc('R16F', 16, 1, 16, false),
    77: unc('RG16', 32, 2, 16, false),
    83: unc('RG16F', 32, 2, 16, false),
    84: unc('RGB16', 48, 3, 16, false),
    90: unc('RGB16F', 48, 3, 16, false),
    91: unc('RGBA16', 64, 4, 16, true),
    97: unc('RGBA16F', 64, 4, 16, true),
    100: unc('R32F', 32, 1, 32, false),
    103: unc('RG32F', 64, 2, 32, false),
    106: unc('RGB32F', 96, 3, 32, false),
    109: unc('RGBA32F', 128, 4, 32, true),
    122: unc('R11G11B10F', 32, 3, null, false),
    123: unc('RGB9E5', 32, 3, null, false),
    131: blk('BC1 RGB', 4, 4, 8, 3, false),
    132: blk('BC1 RGB sRGB', 4, 4, 8, 3, false, true),
    133: blk('BC1 RGBA', 4, 4, 8, 4, null),
    134: blk('BC1 RGBA sRGB', 4, 4, 8, 4, null, true),
    135: blk('BC2', 4, 4, 16, 4, true),
    136: blk('BC2 sRGB', 4, 4, 16, 4, true, true),
    137: blk('BC3', 4, 4, 16, 4, true),
    138: blk('BC3 sRGB', 4, 4, 16, 4, true, true),
    139: blk('BC4', 4, 4, 8, 1, false),
    140: blk('BC4 signed', 4, 4, 8, 1, false),
    141: blk('BC5', 4, 4, 16, 2, false),
    142: blk('BC5 signed', 4, 4, 16, 2, false),
    143: blk('BC6H', 4, 4, 16, 3, false, false, 16),
    144: blk('BC6H signed', 4, 4, 16, 3, false, false, 16),
    145: blk('BC7', 4, 4, 16, 4, null),
    146: blk('BC7 sRGB', 4, 4, 16, 4, null, true),
    147: blk('ETC2 RGB8', 4, 4, 8, 3, false),
    148: blk('ETC2 RGB8 sRGB', 4, 4, 8, 3, false, true),
    149: blk('ETC2 RGB8A1', 4, 4, 8, 4, true),
    150: blk('ETC2 RGB8A1 sRGB', 4, 4, 8, 4, true, true),
    151: blk('ETC2 RGBA8', 4, 4, 16, 4, true),
    152: blk('ETC2 RGBA8 sRGB', 4, 4, 16, 4, true, true),
    153: blk('EAC R11', 4, 4, 8, 1, false),
    154: blk('EAC R11 signed', 4, 4, 8, 1, false),
    155: blk('EAC RG11', 4, 4, 16, 2, false),
    156: blk('EAC RG11 signed', 4, 4, 16, 2, false),
  };
  ASTC_BLOECKE.forEach(([bw, bh], i) => {
    t[157 + 2 * i] = blk(`ASTC ${bw}x${bh}`, bw, bh, 16, 4, null);
    t[158 + 2 * i] = blk(`ASTC ${bw}x${bh} sRGB`, bw, bh, 16, 4, null, true);
  });
  return t;
})();

/** Supercompression von KTX2. */
export const KTX2_SUPERCOMPRESSION: Record<number, string> = { 0: 'keine', 1: 'BasisLZ', 2: 'Zstandard', 3: 'ZLIB' };
