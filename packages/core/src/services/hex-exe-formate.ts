/** P21-T9: mitgelieferte unveraenderliche kaitai-read-v1-Versionen. PG-Spiegel in 133_hex_exe_formate.sql. */
import {createHash} from 'node:crypto';
export const HEX_EXE_FORMATE = [
  {
    "format_id": "f21e0009-0000-4000-8000-000000000001",
    "format_version": 1,
    "name": "exe-mz",
    "beschreibung": "DOS MZ: Header, Relokationssaetze und expliziter Lademodulbereich; grosse Bytes mit hex fenstern.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "4d5a"
        }
      ]
    },
    "format": {
      "instances": {
        "lademodul": {
          "pos": "e_cparhdr * 16",
          "size": "e_cp * 512 - (512 - e_cblp) * (e_cblp != 0) - e_cparhdr * 16",
          "type": "bytes"
        },
        "relocations": {
          "pos": "e_lfarlc",
          "size": "e_crlc * 4",
          "type": "relocations"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_mz"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": "MZ",
          "id": "mz"
        },
        {
          "id": "e_cblp",
          "type": "u2"
        },
        {
          "id": "e_cp",
          "type": "u2"
        },
        {
          "id": "e_crlc",
          "type": "u2"
        },
        {
          "id": "e_cparhdr",
          "type": "u2"
        },
        {
          "id": "e_minalloc",
          "type": "u2"
        },
        {
          "id": "e_maxalloc",
          "type": "u2"
        },
        {
          "id": "e_ss",
          "type": "u2"
        },
        {
          "id": "e_sp",
          "type": "u2"
        },
        {
          "id": "e_csum",
          "type": "u2"
        },
        {
          "id": "e_ip",
          "type": "u2"
        },
        {
          "id": "e_cs",
          "type": "u2"
        },
        {
          "id": "e_lfarlc",
          "type": "u2"
        },
        {
          "id": "e_ovno",
          "type": "u2"
        }
      ],
      "types": {
        "relocation": {
          "seq": [
            {
              "id": "offset",
              "type": "u2"
            },
            {
              "id": "segment",
              "type": "u2"
            }
          ]
        },
        "relocations": {
          "seq": [
            {
              "id": "eintraege",
              "repeat": "expr",
              "repeat-expr": "_root.e_crlc",
              "type": "relocation"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000002",
    "format_version": 1,
    "name": "exe-pe",
    "beschreibung": "PE32/PE32+: DOS-Stubbereich, COFF/Optional-Header, Datenverzeichnisse und Sektionen. Verzeichnis-RVAs ueber adressen aufloesen; Import/Export/Ressourcen/Relocs haben eigene Record-Formate.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "4d5a"
        }
      ],
      "endungen": [
        "exe",
        "dll",
        "sys",
        "ocx"
      ]
    },
    "format": {
      "instances": {
        "dos_stub": {
          "pos": 64,
          "size": "e_lfanew - 64",
          "type": "bytes"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_pe"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": "MZ",
          "id": "mz"
        },
        {
          "id": "e_cblp",
          "type": "u2"
        },
        {
          "id": "e_cp",
          "type": "u2"
        },
        {
          "id": "e_crlc",
          "type": "u2"
        },
        {
          "id": "e_cparhdr",
          "type": "u2"
        },
        {
          "id": "e_minalloc",
          "type": "u2"
        },
        {
          "id": "e_maxalloc",
          "type": "u2"
        },
        {
          "id": "e_ss",
          "type": "u2"
        },
        {
          "id": "e_sp",
          "type": "u2"
        },
        {
          "id": "e_csum",
          "type": "u2"
        },
        {
          "id": "e_ip",
          "type": "u2"
        },
        {
          "id": "e_cs",
          "type": "u2"
        },
        {
          "id": "e_lfarlc",
          "type": "u2"
        },
        {
          "id": "e_ovno",
          "type": "u2"
        },
        {
          "id": "e_res",
          "size": 8,
          "type": "bytes"
        },
        {
          "id": "e_oemid",
          "type": "u2"
        },
        {
          "id": "e_oeminfo",
          "type": "u2"
        },
        {
          "id": "e_res2",
          "size": 20,
          "type": "bytes"
        },
        {
          "id": "e_lfanew",
          "type": "u4"
        },
        {
          "id": "stub_bereich",
          "size": "e_lfanew - 64",
          "type": "luecke"
        },
        {
          "contents": [
            80,
            69,
            0,
            0
          ],
          "id": "pe"
        },
        {
          "id": "machine",
          "type": "u2"
        },
        {
          "id": "section_count",
          "type": "u2"
        },
        {
          "id": "timestamp",
          "type": "u4"
        },
        {
          "id": "symbol_pointer",
          "type": "u4"
        },
        {
          "id": "symbol_count",
          "type": "u4"
        },
        {
          "id": "optional_size",
          "type": "u2"
        },
        {
          "id": "characteristics",
          "type": "u2"
        },
        {
          "id": "optional_magic",
          "type": "u2"
        },
        {
          "id": "optional",
          "size": "optional_size - 2",
          "type": {
            "cases": {
              "267": "optional32",
              "523": "optional64"
            },
            "switch-on": "optional_magic"
          }
        },
        {
          "id": "sections",
          "repeat": "expr",
          "repeat-expr": "section_count",
          "type": "section"
        }
      ],
      "types": {
        "directory": {
          "seq": [
            {
              "id": "rva",
              "type": "u4"
            },
            {
              "id": "bytes",
              "type": "u4"
            }
          ]
        },
        "luecke": {
          "seq": []
        },
        "optional32": {
          "seq": [
            {
              "id": "linker_major",
              "type": "u1"
            },
            {
              "id": "linker_minor",
              "type": "u1"
            },
            {
              "id": "size_code",
              "type": "u4"
            },
            {
              "id": "size_initialized",
              "type": "u4"
            },
            {
              "id": "size_uninitialized",
              "type": "u4"
            },
            {
              "id": "entry_rva",
              "type": "u4"
            },
            {
              "id": "base_code",
              "type": "u4"
            },
            {
              "id": "base_data",
              "type": "u4"
            },
            {
              "id": "image_base",
              "type": "u4"
            },
            {
              "id": "section_alignment",
              "type": "u4"
            },
            {
              "id": "file_alignment",
              "type": "u4"
            },
            {
              "id": "os_major",
              "type": "u2"
            },
            {
              "id": "os_minor",
              "type": "u2"
            },
            {
              "id": "image_major",
              "type": "u2"
            },
            {
              "id": "image_minor",
              "type": "u2"
            },
            {
              "id": "subsystem_major",
              "type": "u2"
            },
            {
              "id": "subsystem_minor",
              "type": "u2"
            },
            {
              "id": "win32_version",
              "type": "u4"
            },
            {
              "id": "size_image",
              "type": "u4"
            },
            {
              "id": "size_headers",
              "type": "u4"
            },
            {
              "id": "checksum",
              "type": "u4"
            },
            {
              "id": "subsystem",
              "type": "u2"
            },
            {
              "id": "dll_flags",
              "type": "u2"
            },
            {
              "id": "stack_reserve",
              "type": "u4"
            },
            {
              "id": "stack_commit",
              "type": "u4"
            },
            {
              "id": "heap_reserve",
              "type": "u4"
            },
            {
              "id": "heap_commit",
              "type": "u4"
            },
            {
              "id": "loader_flags",
              "type": "u4"
            },
            {
              "id": "directory_count",
              "type": "u4"
            },
            {
              "id": "directories",
              "repeat": "expr",
              "repeat-expr": "directory_count",
              "type": "directory"
            }
          ]
        },
        "optional64": {
          "seq": [
            {
              "id": "linker_major",
              "type": "u1"
            },
            {
              "id": "linker_minor",
              "type": "u1"
            },
            {
              "id": "size_code",
              "type": "u4"
            },
            {
              "id": "size_initialized",
              "type": "u4"
            },
            {
              "id": "size_uninitialized",
              "type": "u4"
            },
            {
              "id": "entry_rva",
              "type": "u4"
            },
            {
              "id": "base_code",
              "type": "u4"
            },
            {
              "id": "image_base",
              "type": "u8"
            },
            {
              "id": "section_alignment",
              "type": "u4"
            },
            {
              "id": "file_alignment",
              "type": "u4"
            },
            {
              "id": "os_major",
              "type": "u2"
            },
            {
              "id": "os_minor",
              "type": "u2"
            },
            {
              "id": "image_major",
              "type": "u2"
            },
            {
              "id": "image_minor",
              "type": "u2"
            },
            {
              "id": "subsystem_major",
              "type": "u2"
            },
            {
              "id": "subsystem_minor",
              "type": "u2"
            },
            {
              "id": "win32_version",
              "type": "u4"
            },
            {
              "id": "size_image",
              "type": "u4"
            },
            {
              "id": "size_headers",
              "type": "u4"
            },
            {
              "id": "checksum",
              "type": "u4"
            },
            {
              "id": "subsystem",
              "type": "u2"
            },
            {
              "id": "dll_flags",
              "type": "u2"
            },
            {
              "id": "stack_reserve",
              "type": "u8"
            },
            {
              "id": "stack_commit",
              "type": "u8"
            },
            {
              "id": "heap_reserve",
              "type": "u8"
            },
            {
              "id": "heap_commit",
              "type": "u8"
            },
            {
              "id": "loader_flags",
              "type": "u4"
            },
            {
              "id": "directory_count",
              "type": "u4"
            },
            {
              "id": "directories",
              "repeat": "expr",
              "repeat-expr": "directory_count",
              "type": "directory"
            }
          ]
        },
        "section": {
          "seq": [
            {
              "id": "name",
              "size": 8,
              "type": "bytes"
            },
            {
              "id": "virtual_size",
              "type": "u4"
            },
            {
              "id": "virtual_address",
              "type": "u4"
            },
            {
              "id": "raw_size",
              "type": "u4"
            },
            {
              "id": "raw_pointer",
              "type": "u4"
            },
            {
              "id": "reloc_pointer",
              "type": "u4"
            },
            {
              "id": "line_pointer",
              "type": "u4"
            },
            {
              "id": "reloc_count",
              "type": "u2"
            },
            {
              "id": "line_count",
              "type": "u2"
            },
            {
              "id": "flags",
              "type": "u4"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000003",
    "format_version": 1,
    "name": "exe-ne",
    "beschreibung": "NE: DOS-/NE-Header und Segmenttabelle. Adressen sind Segmentindex:Offset; keine geratenen flachen VAs.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "4d5a"
        }
      ]
    },
    "format": {
      "instances": {
        "segments": {
          "pos": "e_lfanew + ne_segment_offset",
          "size": "ne_segment_count * 8",
          "type": "segments"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_ne"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": "MZ",
          "id": "mz"
        },
        {
          "id": "e_cblp",
          "type": "u2"
        },
        {
          "id": "e_cp",
          "type": "u2"
        },
        {
          "id": "e_crlc",
          "type": "u2"
        },
        {
          "id": "e_cparhdr",
          "type": "u2"
        },
        {
          "id": "e_minalloc",
          "type": "u2"
        },
        {
          "id": "e_maxalloc",
          "type": "u2"
        },
        {
          "id": "e_ss",
          "type": "u2"
        },
        {
          "id": "e_sp",
          "type": "u2"
        },
        {
          "id": "e_csum",
          "type": "u2"
        },
        {
          "id": "e_ip",
          "type": "u2"
        },
        {
          "id": "e_cs",
          "type": "u2"
        },
        {
          "id": "e_lfarlc",
          "type": "u2"
        },
        {
          "id": "e_ovno",
          "type": "u2"
        },
        {
          "id": "e_res",
          "size": 8,
          "type": "bytes"
        },
        {
          "id": "e_oemid",
          "type": "u2"
        },
        {
          "id": "e_oeminfo",
          "type": "u2"
        },
        {
          "id": "e_res2",
          "size": 20,
          "type": "bytes"
        },
        {
          "id": "e_lfanew",
          "type": "u4"
        },
        {
          "id": "stub_bereich",
          "size": "e_lfanew - 64",
          "type": "luecke"
        },
        {
          "contents": "NE",
          "id": "ne_magic"
        },
        {
          "id": "ne_linker_major",
          "type": "u1"
        },
        {
          "id": "ne_linker_minor",
          "type": "u1"
        },
        {
          "id": "ne_entry_offset",
          "type": "u2"
        },
        {
          "id": "ne_entry_bytes",
          "type": "u2"
        },
        {
          "id": "ne_crc",
          "type": "u4"
        },
        {
          "id": "ne_flags",
          "type": "u2"
        },
        {
          "id": "ne_auto_data",
          "type": "u2"
        },
        {
          "id": "ne_heap",
          "type": "u2"
        },
        {
          "id": "ne_stack",
          "type": "u2"
        },
        {
          "id": "ne_ip",
          "type": "u2"
        },
        {
          "id": "ne_cs",
          "type": "u2"
        },
        {
          "id": "ne_sp",
          "type": "u2"
        },
        {
          "id": "ne_ss",
          "type": "u2"
        },
        {
          "id": "ne_segment_count",
          "type": "u2"
        },
        {
          "id": "ne_module_count",
          "type": "u2"
        },
        {
          "id": "ne_nonresident_bytes",
          "type": "u2"
        },
        {
          "id": "ne_segment_offset",
          "type": "u2"
        },
        {
          "id": "ne_resource_offset",
          "type": "u2"
        },
        {
          "id": "ne_resident_offset",
          "type": "u2"
        },
        {
          "id": "ne_module_offset",
          "type": "u2"
        },
        {
          "id": "ne_import_offset",
          "type": "u2"
        },
        {
          "id": "ne_nonresident_offset",
          "type": "u4"
        },
        {
          "id": "ne_movable_count",
          "type": "u2"
        },
        {
          "id": "ne_alignment_shift",
          "type": "u2"
        },
        {
          "id": "ne_resource_count",
          "type": "u2"
        },
        {
          "id": "ne_target_os",
          "type": "u1"
        },
        {
          "id": "ne_other_flags",
          "type": "u1"
        },
        {
          "id": "ne_fastload_offset",
          "type": "u2"
        },
        {
          "id": "ne_fastload_bytes",
          "type": "u2"
        },
        {
          "id": "ne_swap",
          "type": "u2"
        },
        {
          "id": "ne_windows_version",
          "type": "u2"
        }
      ],
      "types": {
        "luecke": {
          "seq": []
        },
        "segment": {
          "seq": [
            {
              "id": "sector",
              "type": "u2"
            },
            {
              "id": "bytes",
              "type": "u2"
            },
            {
              "id": "flags",
              "type": "u2"
            },
            {
              "id": "min_alloc",
              "type": "u2"
            }
          ]
        },
        "segments": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.ne_segment_count",
              "type": "segment"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000004",
    "format_version": 1,
    "name": "exe-le",
    "beschreibung": "LE: DOS-/linearer Header, Objekte und Seitenkarte. Kodierte/iterierte/komprimierte Seiten bleiben als solche kenntlich; keine Loaderausfuehrung.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "4d5a"
        }
      ]
    },
    "format": {
      "instances": {
        "objects": {
          "pos": "e_lfanew + object_table",
          "size": "object_count * 24",
          "type": "objects"
        },
        "pages": {
          "pos": "e_lfanew + page_table",
          "size": "page_count * 4",
          "type": "pages"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_le"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": "MZ",
          "id": "mz"
        },
        {
          "id": "e_cblp",
          "type": "u2"
        },
        {
          "id": "e_cp",
          "type": "u2"
        },
        {
          "id": "e_crlc",
          "type": "u2"
        },
        {
          "id": "e_cparhdr",
          "type": "u2"
        },
        {
          "id": "e_minalloc",
          "type": "u2"
        },
        {
          "id": "e_maxalloc",
          "type": "u2"
        },
        {
          "id": "e_ss",
          "type": "u2"
        },
        {
          "id": "e_sp",
          "type": "u2"
        },
        {
          "id": "e_csum",
          "type": "u2"
        },
        {
          "id": "e_ip",
          "type": "u2"
        },
        {
          "id": "e_cs",
          "type": "u2"
        },
        {
          "id": "e_lfarlc",
          "type": "u2"
        },
        {
          "id": "e_ovno",
          "type": "u2"
        },
        {
          "id": "e_res",
          "size": 8,
          "type": "bytes"
        },
        {
          "id": "e_oemid",
          "type": "u2"
        },
        {
          "id": "e_oeminfo",
          "type": "u2"
        },
        {
          "id": "e_res2",
          "size": 20,
          "type": "bytes"
        },
        {
          "id": "e_lfanew",
          "type": "u4"
        },
        {
          "id": "stub_bereich",
          "size": "e_lfanew - 64",
          "type": "luecke"
        },
        {
          "contents": "LE",
          "id": "linear_magic"
        },
        {
          "id": "byte_order",
          "type": "u1"
        },
        {
          "id": "word_order",
          "type": "u1"
        },
        {
          "id": "format_level",
          "type": "u4"
        },
        {
          "id": "cpu",
          "type": "u2"
        },
        {
          "id": "os",
          "type": "u2"
        },
        {
          "id": "module_version",
          "type": "u4"
        },
        {
          "id": "module_flags",
          "type": "u4"
        },
        {
          "id": "page_count",
          "type": "u4"
        },
        {
          "id": "start_object",
          "type": "u4"
        },
        {
          "id": "eip",
          "type": "u4"
        },
        {
          "id": "stack_object",
          "type": "u4"
        },
        {
          "id": "esp",
          "type": "u4"
        },
        {
          "id": "page_size",
          "type": "u4"
        },
        {
          "id": "last_or_shift",
          "type": "u4"
        },
        {
          "id": "fixup_size",
          "type": "u4"
        },
        {
          "id": "fixup_checksum",
          "type": "u4"
        },
        {
          "id": "loader_size",
          "type": "u4"
        },
        {
          "id": "loader_checksum",
          "type": "u4"
        },
        {
          "id": "object_table",
          "type": "u4"
        },
        {
          "id": "object_count",
          "type": "u4"
        },
        {
          "id": "page_table",
          "type": "u4"
        },
        {
          "id": "iterated_map",
          "type": "u4"
        },
        {
          "id": "resource_table",
          "type": "u4"
        },
        {
          "id": "resource_count",
          "type": "u4"
        },
        {
          "id": "resident_names",
          "type": "u4"
        },
        {
          "id": "entry_table",
          "type": "u4"
        },
        {
          "id": "directives",
          "type": "u4"
        },
        {
          "id": "directive_count",
          "type": "u4"
        },
        {
          "id": "fixup_page_table",
          "type": "u4"
        },
        {
          "id": "fixup_records",
          "type": "u4"
        },
        {
          "id": "import_modules",
          "type": "u4"
        },
        {
          "id": "import_module_count",
          "type": "u4"
        },
        {
          "id": "import_procs",
          "type": "u4"
        },
        {
          "id": "page_checksums",
          "type": "u4"
        },
        {
          "id": "data_pages",
          "type": "u4"
        },
        {
          "id": "preload_count",
          "type": "u4"
        },
        {
          "id": "nonresident_names",
          "type": "u4"
        },
        {
          "id": "nonresident_bytes",
          "type": "u4"
        },
        {
          "id": "nonresident_checksum",
          "type": "u4"
        },
        {
          "id": "auto_data",
          "type": "u4"
        },
        {
          "id": "debug_offset",
          "type": "u4"
        },
        {
          "id": "debug_bytes",
          "type": "u4"
        },
        {
          "id": "instance_preload",
          "type": "u4"
        },
        {
          "id": "instance_demand",
          "type": "u4"
        },
        {
          "id": "heap_size",
          "type": "u4"
        },
        {
          "id": "stack_size",
          "type": "u4"
        }
      ],
      "types": {
        "luecke": {
          "seq": []
        },
        "object": {
          "seq": [
            {
              "id": "virtual_size",
              "type": "u4"
            },
            {
              "id": "base",
              "type": "u4"
            },
            {
              "id": "flags",
              "type": "u4"
            },
            {
              "id": "page_index",
              "type": "u4"
            },
            {
              "id": "page_count",
              "type": "u4"
            },
            {
              "id": "reserved",
              "type": "u4"
            }
          ]
        },
        "objects": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.object_count",
              "type": "object"
            }
          ]
        },
        "page": {
          "seq": [
            {
              "id": "page_number_be24",
              "size": 3,
              "type": "bytes"
            },
            {
              "id": "flags",
              "type": "u1"
            }
          ]
        },
        "pages": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.page_count",
              "type": "page"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000005",
    "format_version": 1,
    "name": "exe-lx",
    "beschreibung": "LX: DOS-/linearer Header, Objekte und Seitenkarte. Kodierte/iterierte/komprimierte Seiten bleiben als solche kenntlich; keine Loaderausfuehrung.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "4d5a"
        }
      ]
    },
    "format": {
      "instances": {
        "objects": {
          "pos": "e_lfanew + object_table",
          "size": "object_count * 24",
          "type": "objects"
        },
        "pages": {
          "pos": "e_lfanew + page_table",
          "size": "page_count * 8",
          "type": "pages"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_lx"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": "MZ",
          "id": "mz"
        },
        {
          "id": "e_cblp",
          "type": "u2"
        },
        {
          "id": "e_cp",
          "type": "u2"
        },
        {
          "id": "e_crlc",
          "type": "u2"
        },
        {
          "id": "e_cparhdr",
          "type": "u2"
        },
        {
          "id": "e_minalloc",
          "type": "u2"
        },
        {
          "id": "e_maxalloc",
          "type": "u2"
        },
        {
          "id": "e_ss",
          "type": "u2"
        },
        {
          "id": "e_sp",
          "type": "u2"
        },
        {
          "id": "e_csum",
          "type": "u2"
        },
        {
          "id": "e_ip",
          "type": "u2"
        },
        {
          "id": "e_cs",
          "type": "u2"
        },
        {
          "id": "e_lfarlc",
          "type": "u2"
        },
        {
          "id": "e_ovno",
          "type": "u2"
        },
        {
          "id": "e_res",
          "size": 8,
          "type": "bytes"
        },
        {
          "id": "e_oemid",
          "type": "u2"
        },
        {
          "id": "e_oeminfo",
          "type": "u2"
        },
        {
          "id": "e_res2",
          "size": 20,
          "type": "bytes"
        },
        {
          "id": "e_lfanew",
          "type": "u4"
        },
        {
          "id": "stub_bereich",
          "size": "e_lfanew - 64",
          "type": "luecke"
        },
        {
          "contents": "LX",
          "id": "linear_magic"
        },
        {
          "id": "byte_order",
          "type": "u1"
        },
        {
          "id": "word_order",
          "type": "u1"
        },
        {
          "id": "format_level",
          "type": "u4"
        },
        {
          "id": "cpu",
          "type": "u2"
        },
        {
          "id": "os",
          "type": "u2"
        },
        {
          "id": "module_version",
          "type": "u4"
        },
        {
          "id": "module_flags",
          "type": "u4"
        },
        {
          "id": "page_count",
          "type": "u4"
        },
        {
          "id": "start_object",
          "type": "u4"
        },
        {
          "id": "eip",
          "type": "u4"
        },
        {
          "id": "stack_object",
          "type": "u4"
        },
        {
          "id": "esp",
          "type": "u4"
        },
        {
          "id": "page_size",
          "type": "u4"
        },
        {
          "id": "last_or_shift",
          "type": "u4"
        },
        {
          "id": "fixup_size",
          "type": "u4"
        },
        {
          "id": "fixup_checksum",
          "type": "u4"
        },
        {
          "id": "loader_size",
          "type": "u4"
        },
        {
          "id": "loader_checksum",
          "type": "u4"
        },
        {
          "id": "object_table",
          "type": "u4"
        },
        {
          "id": "object_count",
          "type": "u4"
        },
        {
          "id": "page_table",
          "type": "u4"
        },
        {
          "id": "iterated_map",
          "type": "u4"
        },
        {
          "id": "resource_table",
          "type": "u4"
        },
        {
          "id": "resource_count",
          "type": "u4"
        },
        {
          "id": "resident_names",
          "type": "u4"
        },
        {
          "id": "entry_table",
          "type": "u4"
        },
        {
          "id": "directives",
          "type": "u4"
        },
        {
          "id": "directive_count",
          "type": "u4"
        },
        {
          "id": "fixup_page_table",
          "type": "u4"
        },
        {
          "id": "fixup_records",
          "type": "u4"
        },
        {
          "id": "import_modules",
          "type": "u4"
        },
        {
          "id": "import_module_count",
          "type": "u4"
        },
        {
          "id": "import_procs",
          "type": "u4"
        },
        {
          "id": "page_checksums",
          "type": "u4"
        },
        {
          "id": "data_pages",
          "type": "u4"
        },
        {
          "id": "preload_count",
          "type": "u4"
        },
        {
          "id": "nonresident_names",
          "type": "u4"
        },
        {
          "id": "nonresident_bytes",
          "type": "u4"
        },
        {
          "id": "nonresident_checksum",
          "type": "u4"
        },
        {
          "id": "auto_data",
          "type": "u4"
        },
        {
          "id": "debug_offset",
          "type": "u4"
        },
        {
          "id": "debug_bytes",
          "type": "u4"
        },
        {
          "id": "instance_preload",
          "type": "u4"
        },
        {
          "id": "instance_demand",
          "type": "u4"
        },
        {
          "id": "heap_size",
          "type": "u4"
        },
        {
          "id": "stack_size",
          "type": "u4"
        }
      ],
      "types": {
        "luecke": {
          "seq": []
        },
        "object": {
          "seq": [
            {
              "id": "virtual_size",
              "type": "u4"
            },
            {
              "id": "base",
              "type": "u4"
            },
            {
              "id": "flags",
              "type": "u4"
            },
            {
              "id": "page_index",
              "type": "u4"
            },
            {
              "id": "page_count",
              "type": "u4"
            },
            {
              "id": "reserved",
              "type": "u4"
            }
          ]
        },
        "objects": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.object_count",
              "type": "object"
            }
          ]
        },
        "page": {
          "seq": [
            {
              "id": "data_offset",
              "type": "u4"
            },
            {
              "id": "data_bytes",
              "type": "u2"
            },
            {
              "id": "flags",
              "type": "u2"
            }
          ]
        },
        "pages": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.page_count",
              "type": "page"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000006",
    "format_version": 1,
    "name": "exe-elf32le",
    "beschreibung": "ELF32 LE: Header, Program-/Section-Header; section_zero legt erweiterte Zaehler offen. Symbole ueber passendes Symbol-Record-Format lesen.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "7f454c460101"
        }
      ]
    },
    "format": {
      "instances": {
        "programs": {
          "if": "e_phnum > 0",
          "pos": "e_phoff",
          "size": "e_phnum * e_phentsize",
          "type": "programs"
        },
        "section_zero": {
          "if": "e_shoff > 0",
          "pos": "e_shoff",
          "size": "e_shentsize",
          "type": "section"
        },
        "sections": {
          "if": "e_shoff > 0 && e_shnum > 0",
          "pos": "e_shoff",
          "size": "e_shnum * e_shentsize",
          "type": "sections"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_elf32le"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": [
            127,
            69,
            76,
            70,
            1,
            1
          ],
          "id": "elf_ident"
        },
        {
          "id": "ei_version",
          "type": "u1"
        },
        {
          "id": "ei_osabi",
          "type": "u1"
        },
        {
          "id": "ei_abiversion",
          "type": "u1"
        },
        {
          "id": "ident_padding",
          "size": 7,
          "type": "bytes"
        },
        {
          "id": "e_type",
          "type": "u2le"
        },
        {
          "id": "e_machine",
          "type": "u2le"
        },
        {
          "id": "e_version",
          "type": "u4le"
        },
        {
          "id": "e_entry",
          "type": "u4le"
        },
        {
          "id": "e_phoff",
          "type": "u4le"
        },
        {
          "id": "e_shoff",
          "type": "u4le"
        },
        {
          "id": "e_flags",
          "type": "u4le"
        },
        {
          "id": "e_ehsize",
          "type": "u2le"
        },
        {
          "id": "e_phentsize",
          "type": "u2le"
        },
        {
          "id": "e_phnum",
          "type": "u2le"
        },
        {
          "id": "e_shentsize",
          "type": "u2le"
        },
        {
          "id": "e_shnum",
          "type": "u2le"
        },
        {
          "id": "e_shstrndx",
          "type": "u2le"
        }
      ],
      "types": {
        "program": {
          "seq": [
            {
              "id": "p_type",
              "type": "u4le"
            },
            {
              "id": "p_offset",
              "type": "u4le"
            },
            {
              "id": "p_vaddr",
              "type": "u4le"
            },
            {
              "id": "p_paddr",
              "type": "u4le"
            },
            {
              "id": "p_filesz",
              "type": "u4le"
            },
            {
              "id": "p_memsz",
              "type": "u4le"
            },
            {
              "id": "p_flags",
              "type": "u4le"
            },
            {
              "id": "p_align",
              "type": "u4le"
            }
          ]
        },
        "programs": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.e_phnum",
              "size": "_root.e_phentsize",
              "type": "program"
            }
          ]
        },
        "section": {
          "seq": [
            {
              "id": "sh_name",
              "type": "u4le"
            },
            {
              "id": "sh_type",
              "type": "u4le"
            },
            {
              "id": "sh_flags",
              "type": "u4le"
            },
            {
              "id": "sh_addr",
              "type": "u4le"
            },
            {
              "id": "sh_offset",
              "type": "u4le"
            },
            {
              "id": "sh_size",
              "type": "u4le"
            },
            {
              "id": "sh_link",
              "type": "u4le"
            },
            {
              "id": "sh_info",
              "type": "u4le"
            },
            {
              "id": "sh_addralign",
              "type": "u4le"
            },
            {
              "id": "sh_entsize",
              "type": "u4le"
            }
          ]
        },
        "sections": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.e_shnum",
              "size": "_root.e_shentsize",
              "type": "section"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000007",
    "format_version": 1,
    "name": "exe-elf32le-symbol",
    "beschreibung": "ELF32 LE Symbol-Record: st_name ist ein Offset in der zugeordneten Stringtabelle.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_elf32le_symbol"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "st_name",
          "type": "u4le"
        },
        {
          "id": "st_value",
          "type": "u4le"
        },
        {
          "id": "st_size",
          "type": "u4le"
        },
        {
          "id": "st_info",
          "type": "u1"
        },
        {
          "id": "st_other",
          "type": "u1"
        },
        {
          "id": "st_shndx",
          "type": "u2le"
        }
      ]
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000008",
    "format_version": 1,
    "name": "exe-elf32be",
    "beschreibung": "ELF32 BE: Header, Program-/Section-Header; section_zero legt erweiterte Zaehler offen. Symbole ueber passendes Symbol-Record-Format lesen.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "7f454c460102"
        }
      ]
    },
    "format": {
      "instances": {
        "programs": {
          "if": "e_phnum > 0",
          "pos": "e_phoff",
          "size": "e_phnum * e_phentsize",
          "type": "programs"
        },
        "section_zero": {
          "if": "e_shoff > 0",
          "pos": "e_shoff",
          "size": "e_shentsize",
          "type": "section"
        },
        "sections": {
          "if": "e_shoff > 0 && e_shnum > 0",
          "pos": "e_shoff",
          "size": "e_shnum * e_shentsize",
          "type": "sections"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_elf32be"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": [
            127,
            69,
            76,
            70,
            1,
            2
          ],
          "id": "elf_ident"
        },
        {
          "id": "ei_version",
          "type": "u1"
        },
        {
          "id": "ei_osabi",
          "type": "u1"
        },
        {
          "id": "ei_abiversion",
          "type": "u1"
        },
        {
          "id": "ident_padding",
          "size": 7,
          "type": "bytes"
        },
        {
          "id": "e_type",
          "type": "u2be"
        },
        {
          "id": "e_machine",
          "type": "u2be"
        },
        {
          "id": "e_version",
          "type": "u4be"
        },
        {
          "id": "e_entry",
          "type": "u4be"
        },
        {
          "id": "e_phoff",
          "type": "u4be"
        },
        {
          "id": "e_shoff",
          "type": "u4be"
        },
        {
          "id": "e_flags",
          "type": "u4be"
        },
        {
          "id": "e_ehsize",
          "type": "u2be"
        },
        {
          "id": "e_phentsize",
          "type": "u2be"
        },
        {
          "id": "e_phnum",
          "type": "u2be"
        },
        {
          "id": "e_shentsize",
          "type": "u2be"
        },
        {
          "id": "e_shnum",
          "type": "u2be"
        },
        {
          "id": "e_shstrndx",
          "type": "u2be"
        }
      ],
      "types": {
        "program": {
          "seq": [
            {
              "id": "p_type",
              "type": "u4be"
            },
            {
              "id": "p_offset",
              "type": "u4be"
            },
            {
              "id": "p_vaddr",
              "type": "u4be"
            },
            {
              "id": "p_paddr",
              "type": "u4be"
            },
            {
              "id": "p_filesz",
              "type": "u4be"
            },
            {
              "id": "p_memsz",
              "type": "u4be"
            },
            {
              "id": "p_flags",
              "type": "u4be"
            },
            {
              "id": "p_align",
              "type": "u4be"
            }
          ]
        },
        "programs": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.e_phnum",
              "size": "_root.e_phentsize",
              "type": "program"
            }
          ]
        },
        "section": {
          "seq": [
            {
              "id": "sh_name",
              "type": "u4be"
            },
            {
              "id": "sh_type",
              "type": "u4be"
            },
            {
              "id": "sh_flags",
              "type": "u4be"
            },
            {
              "id": "sh_addr",
              "type": "u4be"
            },
            {
              "id": "sh_offset",
              "type": "u4be"
            },
            {
              "id": "sh_size",
              "type": "u4be"
            },
            {
              "id": "sh_link",
              "type": "u4be"
            },
            {
              "id": "sh_info",
              "type": "u4be"
            },
            {
              "id": "sh_addralign",
              "type": "u4be"
            },
            {
              "id": "sh_entsize",
              "type": "u4be"
            }
          ]
        },
        "sections": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.e_shnum",
              "size": "_root.e_shentsize",
              "type": "section"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000009",
    "format_version": 1,
    "name": "exe-elf32be-symbol",
    "beschreibung": "ELF32 BE Symbol-Record: st_name ist ein Offset in der zugeordneten Stringtabelle.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_elf32be_symbol"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "st_name",
          "type": "u4be"
        },
        {
          "id": "st_value",
          "type": "u4be"
        },
        {
          "id": "st_size",
          "type": "u4be"
        },
        {
          "id": "st_info",
          "type": "u1"
        },
        {
          "id": "st_other",
          "type": "u1"
        },
        {
          "id": "st_shndx",
          "type": "u2be"
        }
      ]
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000010",
    "format_version": 1,
    "name": "exe-elf64le",
    "beschreibung": "ELF64 LE: Header, Program-/Section-Header; section_zero legt erweiterte Zaehler offen. Symbole ueber passendes Symbol-Record-Format lesen.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "7f454c460201"
        }
      ]
    },
    "format": {
      "instances": {
        "programs": {
          "if": "e_phnum > 0",
          "pos": "e_phoff",
          "size": "e_phnum * e_phentsize",
          "type": "programs"
        },
        "section_zero": {
          "if": "e_shoff > 0",
          "pos": "e_shoff",
          "size": "e_shentsize",
          "type": "section"
        },
        "sections": {
          "if": "e_shoff > 0 && e_shnum > 0",
          "pos": "e_shoff",
          "size": "e_shnum * e_shentsize",
          "type": "sections"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_elf64le"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": [
            127,
            69,
            76,
            70,
            2,
            1
          ],
          "id": "elf_ident"
        },
        {
          "id": "ei_version",
          "type": "u1"
        },
        {
          "id": "ei_osabi",
          "type": "u1"
        },
        {
          "id": "ei_abiversion",
          "type": "u1"
        },
        {
          "id": "ident_padding",
          "size": 7,
          "type": "bytes"
        },
        {
          "id": "e_type",
          "type": "u2le"
        },
        {
          "id": "e_machine",
          "type": "u2le"
        },
        {
          "id": "e_version",
          "type": "u4le"
        },
        {
          "id": "e_entry",
          "type": "u8le"
        },
        {
          "id": "e_phoff",
          "type": "u8le"
        },
        {
          "id": "e_shoff",
          "type": "u8le"
        },
        {
          "id": "e_flags",
          "type": "u4le"
        },
        {
          "id": "e_ehsize",
          "type": "u2le"
        },
        {
          "id": "e_phentsize",
          "type": "u2le"
        },
        {
          "id": "e_phnum",
          "type": "u2le"
        },
        {
          "id": "e_shentsize",
          "type": "u2le"
        },
        {
          "id": "e_shnum",
          "type": "u2le"
        },
        {
          "id": "e_shstrndx",
          "type": "u2le"
        }
      ],
      "types": {
        "program": {
          "seq": [
            {
              "id": "p_type",
              "type": "u4le"
            },
            {
              "id": "p_flags",
              "type": "u4le"
            },
            {
              "id": "p_offset",
              "type": "u8le"
            },
            {
              "id": "p_vaddr",
              "type": "u8le"
            },
            {
              "id": "p_paddr",
              "type": "u8le"
            },
            {
              "id": "p_filesz",
              "type": "u8le"
            },
            {
              "id": "p_memsz",
              "type": "u8le"
            },
            {
              "id": "p_align",
              "type": "u8le"
            }
          ]
        },
        "programs": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.e_phnum",
              "size": "_root.e_phentsize",
              "type": "program"
            }
          ]
        },
        "section": {
          "seq": [
            {
              "id": "sh_name",
              "type": "u4le"
            },
            {
              "id": "sh_type",
              "type": "u4le"
            },
            {
              "id": "sh_flags",
              "type": "u8le"
            },
            {
              "id": "sh_addr",
              "type": "u8le"
            },
            {
              "id": "sh_offset",
              "type": "u8le"
            },
            {
              "id": "sh_size",
              "type": "u8le"
            },
            {
              "id": "sh_link",
              "type": "u4le"
            },
            {
              "id": "sh_info",
              "type": "u4le"
            },
            {
              "id": "sh_addralign",
              "type": "u8le"
            },
            {
              "id": "sh_entsize",
              "type": "u8le"
            }
          ]
        },
        "sections": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.e_shnum",
              "size": "_root.e_shentsize",
              "type": "section"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000011",
    "format_version": 1,
    "name": "exe-elf64le-symbol",
    "beschreibung": "ELF64 LE Symbol-Record: st_name ist ein Offset in der zugeordneten Stringtabelle.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_elf64le_symbol"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "st_name",
          "type": "u4le"
        },
        {
          "id": "st_info",
          "type": "u1"
        },
        {
          "id": "st_other",
          "type": "u1"
        },
        {
          "id": "st_shndx",
          "type": "u2le"
        },
        {
          "id": "st_value",
          "type": "u8le"
        },
        {
          "id": "st_size",
          "type": "u8le"
        }
      ]
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000012",
    "format_version": 1,
    "name": "exe-elf64be",
    "beschreibung": "ELF64 BE: Header, Program-/Section-Header; section_zero legt erweiterte Zaehler offen. Symbole ueber passendes Symbol-Record-Format lesen.",
    "erkennung": {
      "magic": [
        {
          "offset": "0",
          "hex": "7f454c460202"
        }
      ]
    },
    "format": {
      "instances": {
        "programs": {
          "if": "e_phnum > 0",
          "pos": "e_phoff",
          "size": "e_phnum * e_phentsize",
          "type": "programs"
        },
        "section_zero": {
          "if": "e_shoff > 0",
          "pos": "e_shoff",
          "size": "e_shentsize",
          "type": "section"
        },
        "sections": {
          "if": "e_shoff > 0 && e_shnum > 0",
          "pos": "e_shoff",
          "size": "e_shnum * e_shentsize",
          "type": "sections"
        }
      },
      "meta": {
        "endian": "le",
        "id": "exe_elf64be"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "contents": [
            127,
            69,
            76,
            70,
            2,
            2
          ],
          "id": "elf_ident"
        },
        {
          "id": "ei_version",
          "type": "u1"
        },
        {
          "id": "ei_osabi",
          "type": "u1"
        },
        {
          "id": "ei_abiversion",
          "type": "u1"
        },
        {
          "id": "ident_padding",
          "size": 7,
          "type": "bytes"
        },
        {
          "id": "e_type",
          "type": "u2be"
        },
        {
          "id": "e_machine",
          "type": "u2be"
        },
        {
          "id": "e_version",
          "type": "u4be"
        },
        {
          "id": "e_entry",
          "type": "u8be"
        },
        {
          "id": "e_phoff",
          "type": "u8be"
        },
        {
          "id": "e_shoff",
          "type": "u8be"
        },
        {
          "id": "e_flags",
          "type": "u4be"
        },
        {
          "id": "e_ehsize",
          "type": "u2be"
        },
        {
          "id": "e_phentsize",
          "type": "u2be"
        },
        {
          "id": "e_phnum",
          "type": "u2be"
        },
        {
          "id": "e_shentsize",
          "type": "u2be"
        },
        {
          "id": "e_shnum",
          "type": "u2be"
        },
        {
          "id": "e_shstrndx",
          "type": "u2be"
        }
      ],
      "types": {
        "program": {
          "seq": [
            {
              "id": "p_type",
              "type": "u4be"
            },
            {
              "id": "p_flags",
              "type": "u4be"
            },
            {
              "id": "p_offset",
              "type": "u8be"
            },
            {
              "id": "p_vaddr",
              "type": "u8be"
            },
            {
              "id": "p_paddr",
              "type": "u8be"
            },
            {
              "id": "p_filesz",
              "type": "u8be"
            },
            {
              "id": "p_memsz",
              "type": "u8be"
            },
            {
              "id": "p_align",
              "type": "u8be"
            }
          ]
        },
        "programs": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.e_phnum",
              "size": "_root.e_phentsize",
              "type": "program"
            }
          ]
        },
        "section": {
          "seq": [
            {
              "id": "sh_name",
              "type": "u4be"
            },
            {
              "id": "sh_type",
              "type": "u4be"
            },
            {
              "id": "sh_flags",
              "type": "u8be"
            },
            {
              "id": "sh_addr",
              "type": "u8be"
            },
            {
              "id": "sh_offset",
              "type": "u8be"
            },
            {
              "id": "sh_size",
              "type": "u8be"
            },
            {
              "id": "sh_link",
              "type": "u4be"
            },
            {
              "id": "sh_info",
              "type": "u4be"
            },
            {
              "id": "sh_addralign",
              "type": "u8be"
            },
            {
              "id": "sh_entsize",
              "type": "u8be"
            }
          ]
        },
        "sections": {
          "seq": [
            {
              "id": "entries",
              "repeat": "expr",
              "repeat-expr": "_root.e_shnum",
              "size": "_root.e_shentsize",
              "type": "section"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000013",
    "format_version": 1,
    "name": "exe-elf64be-symbol",
    "beschreibung": "ELF64 BE Symbol-Record: st_name ist ein Offset in der zugeordneten Stringtabelle.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_elf64be_symbol"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "st_name",
          "type": "u4be"
        },
        {
          "id": "st_info",
          "type": "u1"
        },
        {
          "id": "st_other",
          "type": "u1"
        },
        {
          "id": "st_shndx",
          "type": "u2be"
        },
        {
          "id": "st_value",
          "type": "u8be"
        },
        {
          "id": "st_size",
          "type": "u8be"
        }
      ]
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000014",
    "format_version": 1,
    "name": "exe-pe-import",
    "beschreibung": "Ein PE-Importdeskriptor (20 Bytes); Nullsatz terminiert. Zeiger mit adressen aufloesen.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_pe_import"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "lookup_rva",
          "type": "u4"
        },
        {
          "id": "timestamp",
          "type": "u4"
        },
        {
          "id": "forwarder_chain",
          "type": "u4"
        },
        {
          "id": "name_rva",
          "type": "u4"
        },
        {
          "id": "iat_rva",
          "type": "u4"
        }
      ]
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000015",
    "format_version": 1,
    "name": "exe-pe-export",
    "beschreibung": "PE-Exportverzeichnis (40 Bytes); Tabellen-RVAs mit adressen aufloesen.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_pe_export"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "flags",
          "type": "u4"
        },
        {
          "id": "timestamp",
          "type": "u4"
        },
        {
          "id": "major",
          "type": "u2"
        },
        {
          "id": "minor",
          "type": "u2"
        },
        {
          "id": "name_rva",
          "type": "u4"
        },
        {
          "id": "ordinal_base",
          "type": "u4"
        },
        {
          "id": "function_count",
          "type": "u4"
        },
        {
          "id": "name_count",
          "type": "u4"
        },
        {
          "id": "function_table_rva",
          "type": "u4"
        },
        {
          "id": "name_table_rva",
          "type": "u4"
        },
        {
          "id": "ordinal_table_rva",
          "type": "u4"
        }
      ]
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000016",
    "format_version": 1,
    "name": "exe-pe-resource",
    "beschreibung": "Eine PE-Ressourcenverzeichnis-Ebene; Bit31 markiert Namen bzw. Unterverzeichnisse, Offsets relativ zur Ressourcenwurzel.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_pe_resource"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "flags",
          "type": "u4"
        },
        {
          "id": "timestamp",
          "type": "u4"
        },
        {
          "id": "major",
          "type": "u2"
        },
        {
          "id": "minor",
          "type": "u2"
        },
        {
          "id": "named_count",
          "type": "u2"
        },
        {
          "id": "id_count",
          "type": "u2"
        },
        {
          "id": "entries",
          "repeat": "expr",
          "repeat-expr": "named_count + id_count",
          "type": "entry"
        }
      ],
      "types": {
        "entry": {
          "seq": [
            {
              "id": "name_or_id",
              "type": "u4"
            },
            {
              "id": "child_or_data",
              "type": "u4"
            }
          ]
        }
      }
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000017",
    "format_version": 1,
    "name": "exe-pe-resource-data",
    "beschreibung": "PE-Ressourcen-Dateneintrag; data_rva ist keine Position relativ zur Ressourcenwurzel.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_pe_resource_data"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "data_rva",
          "type": "u4"
        },
        {
          "id": "bytes",
          "type": "u4"
        },
        {
          "id": "codepage",
          "type": "u4"
        },
        {
          "id": "reserved",
          "type": "u4"
        }
      ]
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  },
  {
    "format_id": "f21e0009-0000-4000-8000-000000000018",
    "format_version": 1,
    "name": "exe-pe-reloc",
    "beschreibung": "Ein PE-Basisrelokationsblock; high4=Typ, low12=Seitenoffset. Keine Relokation wird angewendet.",
    "erkennung": {},
    "format": {
      "meta": {
        "endian": "le",
        "id": "exe_pe_reloc"
      },
      "profil": "kaitai-read-v1",
      "seq": [
        {
          "id": "page_rva",
          "type": "u4"
        },
        {
          "id": "block_bytes",
          "type": "u4"
        },
        {
          "id": "entries",
          "repeat": "expr",
          "repeat-expr": "(block_bytes - 8) / 2",
          "type": "u2"
        }
      ]
    },
    "herkunft": {
      "lieferung": "P21-T9/H5a",
      "quellen": [
        "https://learn.microsoft.com/en-us/windows/win32/debug/pe-format",
        "https://gabi.xinuos.com/elf/07-pheader.html",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeos2.h",
        "https://raw.githubusercontent.com/open-watcom/open-watcom-v2/master/bld/watcom/h/exeflat.h"
      ]
    }
  }
] as const;
export const hexExeFormat=(name:string)=>HEX_EXE_FORMATE.find(f=>f.name===name);
export function hexExeFormatHash(e:typeof HEX_EXE_FORMATE[number]):string{return createHash('sha256').update(JSON.stringify(e.format)).digest('hex');}
