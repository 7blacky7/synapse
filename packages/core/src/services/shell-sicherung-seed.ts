/** P10-T35: unabhängige Seeds; keine DCG-Regeln oder Packtexte. */
import type { ShellSicherungsKatalog } from './shell-sicherung.js';
export const SHELL_SICHERUNG_SEED: ShellSicherungsKatalog = {
  "regeln": [
    {
      "id": "fs.rm",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^(?:g?rm)$"
        ]
      },
      "antwort_id": "fs.rm",
      "quelle": "https://www.gnu.org/software/coreutils/manual/html_node/rm-invocation.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "rm -rf ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "fs.find",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^find$"
        ],
        "argv_any": [
          "^-delete$",
          "^-exec(?:dir)?$"
        ]
      },
      "antwort_id": "fs.find",
      "quelle": "https://www.gnu.org/software/findutils/manual/html_node/find_html/Delete-Files.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "find . -delete"
      ],
      "negativ": [
        "find . -print"
      ]
    },
    {
      "id": "fs.chmod",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^chmod$"
        ],
        "argv_any": [
          "^-[A-Za-z]*R",
          "^777$",
          "^a\\+rwx$"
        ]
      },
      "antwort_id": "fs.chmod",
      "quelle": "https://www.gnu.org/software/coreutils/manual/html_node/chmod-invocation.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "chmod -R 777 ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "fs.chown",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^chown$"
        ],
        "argv_any": [
          "^-[A-Za-z]*R"
        ]
      },
      "antwort_id": "fs.chown",
      "quelle": "https://www.gnu.org/software/coreutils/manual/html_node/chown-invocation.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "chown -R user ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "fs.dd",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^dd$"
        ],
        "argv_any": [
          "^of="
        ]
      },
      "antwort_id": "fs.dd",
      "quelle": "https://www.gnu.org/software/coreutils/manual/html_node/dd-invocation.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "dd if=input of=output"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "fs.redirect",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [],
        "umleitung": true,
        "target_regex": "^(?:/etc/|/dev/(?!null$)|.*(?:\\.env|\\.git/|id_rsa|credentials).*)"
      },
      "antwort_id": "fs.redirect",
      "quelle": "https://www.gnu.org/software/bash/manual/html_node/Redirections.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "echo x > .env"
      ],
      "negativ": [
        "echo x > /tmp/build.log"
      ]
    },
    {
      "id": "git.clean",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^clean$"
        ],
        "argv_any": [
          "^-[A-Za-z]*f",
          "^--force$"
        ],
        "argv_none": [
          "^-[A-Za-z]*n",
          "^--dry-run$"
        ]
      },
      "antwort_id": "git.clean",
      "quelle": "https://git-scm.com/docs/git-clean",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git clean -fdx"
      ],
      "negativ": [
        "git clean -ndx"
      ]
    },
    {
      "id": "git.reset",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^reset$"
        ],
        "argv_any": [
          "^--hard$",
          "^--merge$",
          "^--keep$"
        ]
      },
      "antwort_id": "git.reset",
      "quelle": "https://git-scm.com/docs/git-reset",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git reset --hard"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.restore",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^restore$"
        ]
      },
      "antwort_id": "git.restore",
      "quelle": "https://git-scm.com/docs/git-restore",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git restore ."
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.checkout",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^checkout$"
        ]
      },
      "antwort_id": "git.checkout",
      "quelle": "https://git-scm.com/docs/git-checkout",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git checkout ."
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.branch",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^branch$"
        ],
        "argv_any": [
          "^-D$",
          "^--delete$",
          "^-d$"
        ]
      },
      "antwort_id": "git.branch",
      "quelle": "https://git-scm.com/docs/git-branch",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git branch -D main"
      ],
      "negativ": [
        "git branch -vv"
      ]
    },
    {
      "id": "git.remote",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^remote$"
        ],
        "argv_any": [
          "^remove$",
          "^rm$",
          "^set-url$"
        ]
      },
      "antwort_id": "git.remote",
      "quelle": "https://git-scm.com/docs/git-remote",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git remote remove origin"
      ],
      "negativ": [
        "git remote -v"
      ]
    },
    {
      "id": "git.push",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^push$"
        ],
        "argv_any": [
          "^--force(?:-with-lease)?(?:=.*)?$",
          "^-f$",
          "^--mirror$",
          "^--delete$",
          "^--prune$",
          "^:[^:]"
        ],
        "argv_none": [
          "^--dry-run$",
          "^-n$"
        ]
      },
      "antwort_id": "git.push",
      "quelle": "https://git-scm.com/docs/git-push",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git push --force"
      ],
      "negativ": [
        "git push --force --dry-run"
      ]
    },
    {
      "id": "git.stash",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^stash$"
        ],
        "argv_any": [
          "^clear$",
          "^drop$"
        ]
      },
      "antwort_id": "git.stash",
      "quelle": "https://git-scm.com/docs/git-stash",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git stash clear"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.rebase",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^rebase$"
        ],
        "argv_none": [
          "^--abort$",
          "^--show-current-patch$"
        ]
      },
      "antwort_id": "git.rebase",
      "quelle": "https://git-scm.com/docs/git-rebase",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git rebase main"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.amend",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^commit$"
        ],
        "argv_any": [
          "^--amend$"
        ]
      },
      "antwort_id": "git.amend",
      "quelle": "https://git-scm.com/docs/git-commit",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git commit --amend"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.worktree",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^worktree$"
        ],
        "argv_any": [
          "^remove$"
        ]
      },
      "antwort_id": "git.worktree",
      "quelle": "https://git-scm.com/docs/git-worktree",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git worktree remove ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.submodule",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^submodule$"
        ],
        "argv_any": [
          "^deinit$"
        ]
      },
      "antwort_id": "git.submodule",
      "quelle": "https://git-scm.com/docs/git-submodule",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git submodule deinit -f ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.gc",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^gc$"
        ],
        "argv_any": [
          "^--prune=now$"
        ]
      },
      "antwort_id": "git.gc",
      "quelle": "https://git-scm.com/docs/git-gc",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git gc --prune=now"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.reflog",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^reflog$"
        ],
        "argv_any": [
          "^expire$",
          "^delete$"
        ]
      },
      "antwort_id": "git.reflog",
      "quelle": "https://git-scm.com/docs/git-reflog",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git reflog expire --expire=now"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.filter",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^(?:filter-branch|filter-repo)$"
        ]
      },
      "antwort_id": "git.filter",
      "quelle": "https://git-scm.com/docs/git-filter-branch",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git filter-branch --all"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.add",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^git$",
          "^add$"
        ],
        "argv_any": [
          "^\\.$",
          "^-A$",
          "^--all$"
        ]
      },
      "antwort_id": "git.add",
      "quelle": "https://git-scm.com/docs/git-add",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git add ."
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "sync.rsync",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^rsync$"
        ],
        "argv_any": [
          "^--delete(?:-.*)?$"
        ],
        "argv_none": [
          "^--dry-run$",
          "^-[A-Za-z]*n"
        ]
      },
      "antwort_id": "sync.rsync",
      "quelle": "https://download.samba.org/pub/rsync/rsync.1",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "rsync --delete source/ dest/"
      ],
      "negativ": [
        "rsync --delete --dry-run a b"
      ]
    },
    {
      "id": "sync.rclone",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^rclone$",
          "^sync$"
        ],
        "argv_none": [
          "^--dry-run$"
        ]
      },
      "antwort_id": "sync.rclone",
      "quelle": "https://rclone.org/commands/rclone_sync/",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "rclone sync source dest"
      ],
      "negativ": [
        "rclone sync --dry-run a b"
      ]
    },
    {
      "id": "sync.robocopy",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^robocopy(?:\\.exe)?$"
        ],
        "argv_any": [
          "^/(?:mir|purge|mov|move)$"
        ],
        "argv_none": [
          "^/l$"
        ]
      },
      "antwort_id": "sync.robocopy",
      "quelle": "https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/robocopy",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "robocopy source dest /MIR"
      ],
      "negativ": [
        "robocopy source dest /MIR /L"
      ]
    },
    {
      "id": "win.remove",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^(?:remove-item|ri|del|erase|rd|rmdir)(?:\\.exe)?$"
        ]
      },
      "antwort_id": "win.remove",
      "quelle": "https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/remove-item",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "Remove-Item \"$p\" -Recurse -Force"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "docker.prune",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^docker$",
          "^(?:system|volume|image|container|builder)$"
        ],
        "argv_any": [
          "^prune$"
        ]
      },
      "antwort_id": "docker.prune",
      "quelle": "https://docs.docker.com/reference/cli/docker/system/prune/",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "docker system prune -a"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "docker.volume",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^docker$",
          "^volume$"
        ],
        "argv_any": [
          "^rm$"
        ]
      },
      "antwort_id": "docker.volume",
      "quelle": "https://docs.docker.com/reference/cli/docker/volume/rm/",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "docker volume rm data"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "docker.remove",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^docker$",
          "^(?:rm|rmi)$"
        ]
      },
      "antwort_id": "docker.remove",
      "quelle": "https://docs.docker.com/reference/cli/docker/container/rm/",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "docker rm app"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "docker.compose",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^docker$",
          "^compose$"
        ],
        "argv_any": [
          "^down$"
        ]
      },
      "antwort_id": "docker.compose",
      "quelle": "https://docs.docker.com/reference/cli/docker/compose/down/",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "docker compose down -v"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "db.sql",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^(?:psql|mysql|mariadb|sqlite3)$"
        ],
        "argv_any": [
          "\\b(?:drop\\s+(?:database|schema|table)|truncate\\s|delete\\s+from|update\\s+\\w+\\s+set)"
        ]
      },
      "antwort_id": "db.sql",
      "quelle": "https://www.postgresql.org/docs/current/sql-delete.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "psql -c \"DELETE FROM t\""
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "db.redis",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^redis-cli$"
        ],
        "argv_any": [
          "^flush(?:all|db)$"
        ]
      },
      "antwort_id": "db.redis",
      "quelle": "https://redis.io/docs/latest/commands/flushall/",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "redis-cli FLUSHALL"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "inline.python",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^python[\\d.]*$"
        ],
        "argv_any": [
          "\\b(?:rmtree|unlink|remove|copyfile|move|write_text|write_bytes)\\s*\\("
        ],
        "argv_all": [
          "^-c$"
        ]
      },
      "antwort_id": "inline.python",
      "quelle": "https://docs.python.org/3/library/shutil.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "python -c \"import shutil; shutil.rmtree('x')\""
      ],
      "negativ": [
        "python -c \"print('rmtree')\""
      ]
    },
    {
      "id": "inline.node",
      "version": 1,
      "art": "text",
      "stufe": "anleitung",
      "status": "aktiv",
      "muster": {
        "command": [
          "^node$"
        ],
        "argv_any": [
          "\\b(?:rmSync|rm|unlinkSync|unlink|writeFileSync|writeFile|renameSync|rename)\\s*\\("
        ],
        "argv_all": [
          "^(?:-e|--eval)$"
        ]
      },
      "antwort_id": "inline.node",
      "quelle": "https://nodejs.org/api/fs.html",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "node -e \"require('fs').rmSync('x')\""
      ],
      "negativ": [
        "node -e \"console.log('rmSync')\""
      ]
    }
  ],
  "antworten": [
    {
      "id": "fs.rm",
      "version": 1,
      "beschreibung": "fs.rm",
      "risiko": "Dateien oder Verzeichnisbäume werden entfernt.",
      "sicher": {
        "bash": "find {{ziel}} -maxdepth 1 -print",
        "sh": "find {{ziel}} -maxdepth 1 -print",
        "pwsh": "Get-Item -LiteralPath {{ziel}} -Force",
        "cmd": "dir /a {{ziel}}"
      },
      "danach": "Die aufgelöste Ziel- und Trefferliste prüfen, Sicherung klären; anschließend eine auf diese Ziele begrenzte Variante verwenden.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://www.gnu.org/software/coreutils/manual/html_node/rm-invocation.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "rm -rf ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "fs.find",
      "version": 1,
      "beschreibung": "fs.find",
      "risiko": "Treffer werden entfernt oder verändert.",
      "sicher": {
        "bash": "find {{ziel}} -maxdepth 1 -print",
        "sh": "find {{ziel}} -maxdepth 1 -print",
        "pwsh": "Get-Item -LiteralPath {{ziel}} -Force",
        "cmd": "dir /a {{ziel}}"
      },
      "danach": "Die aufgelöste Ziel- und Trefferliste prüfen, Sicherung klären; anschließend eine auf diese Ziele begrenzte Variante verwenden.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://www.gnu.org/software/findutils/manual/html_node/find_html/Delete-Files.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "find . -delete"
      ],
      "negativ": [
        "find . -print"
      ]
    },
    {
      "id": "fs.chmod",
      "version": 1,
      "beschreibung": "fs.chmod",
      "risiko": "Rechte werden rekursiv oder für alle Konten geöffnet.",
      "sicher": {
        "bash": "stat -- {{ziel}}",
        "sh": "stat -- {{ziel}}",
        "pwsh": "Get-Acl -LiteralPath {{ziel}}"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://www.gnu.org/software/coreutils/manual/html_node/chmod-invocation.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "chmod -R 777 ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "fs.chown",
      "version": 1,
      "beschreibung": "fs.chown",
      "risiko": "Eigentümer werden rekursiv auf einem Baum verändert.",
      "sicher": {
        "bash": "stat -- {{ziel}}",
        "sh": "stat -- {{ziel}}",
        "pwsh": "Get-Acl -LiteralPath {{ziel}}"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://www.gnu.org/software/coreutils/manual/html_node/chown-invocation.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "chown -R user ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "fs.dd",
      "version": 1,
      "beschreibung": "fs.dd",
      "risiko": "Ein Ausgabegerät oder eine Datei wird blockweise überschrieben.",
      "sicher": {
        "bash": "lsblk -f",
        "sh": "lsblk -f",
        "pwsh": "Get-Disk"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://www.gnu.org/software/coreutils/manual/html_node/dd-invocation.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "dd if=input of=output"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "fs.redirect",
      "version": 1,
      "beschreibung": "fs.redirect",
      "risiko": "Die Ausgabe verändert den Zielinhalt.",
      "sicher": {
        "bash": "find {{ziel}} -maxdepth 1 -print",
        "sh": "find {{ziel}} -maxdepth 1 -print",
        "pwsh": "Get-Item -LiteralPath {{ziel}} -Force",
        "cmd": "dir /a {{ziel}}"
      },
      "danach": "Die aufgelöste Ziel- und Trefferliste prüfen, Sicherung klären; anschließend eine auf diese Ziele begrenzte Variante verwenden.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://www.gnu.org/software/bash/manual/html_node/Redirections.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "echo x > .env"
      ],
      "negativ": [
        "echo x > /tmp/build.log"
      ]
    },
    {
      "id": "git.clean",
      "version": 1,
      "beschreibung": "git.clean",
      "risiko": "Nicht versionierte Dateien werden gelöscht, bei -x auch ignorierte Dateien.",
      "sicher": {
        "bash": "git clean -ndx -- {{ziel}}",
        "sh": "git clean -ndx -- {{ziel}}",
        "pwsh": "git clean -ndx -- {{ziel}}",
        "cmd": "git clean -ndx -- {{ziel}}"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://git-scm.com/docs/git-clean",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git clean -fdx"
      ],
      "negativ": [
        "git clean -ndx"
      ]
    },
    {
      "id": "git.reset",
      "version": 1,
      "beschreibung": "git.reset",
      "risiko": "--hard ersetzt Worktree und Index, lokale Änderungen können verloren gehen.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-reset",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git reset --hard"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.restore",
      "version": 1,
      "beschreibung": "git.restore",
      "risiko": "Vorhandene Arbeitsdateien oder Indexeinträge werden ersetzt.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-restore",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git restore ."
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.checkout",
      "version": 1,
      "beschreibung": "git.checkout",
      "risiko": "Branch oder Dateistände werden gewechselt, lokale Arbeit kann ersetzt werden.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-checkout",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git checkout ."
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.branch",
      "version": 1,
      "beschreibung": "git.branch",
      "risiko": "Ein Branch wird gelöscht; er kann noch nicht zusammengeführte Commits tragen.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-branch",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git branch -D main"
      ],
      "negativ": [
        "git branch -vv"
      ]
    },
    {
      "id": "git.remote",
      "version": 1,
      "beschreibung": "git.remote",
      "risiko": "Remote-Namen oder Remote-Ziele werden verändert.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-remote",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git remote remove origin"
      ],
      "negativ": [
        "git remote -v"
      ]
    },
    {
      "id": "git.push",
      "version": 1,
      "beschreibung": "git.push",
      "risiko": "Remote-Referenzen können gelöscht oder gegen den bisherigen Stand ersetzt werden.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-push",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git push --force"
      ],
      "negativ": [
        "git push --force --dry-run"
      ]
    },
    {
      "id": "git.stash",
      "version": 1,
      "beschreibung": "git.stash",
      "risiko": "Gesicherte Arbeitsstände werden entfernt.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-stash",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git stash clear"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.rebase",
      "version": 1,
      "beschreibung": "git.rebase",
      "risiko": "Commit-IDs und Branch-Historie werden umgeschrieben.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-rebase",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git rebase main"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.amend",
      "version": 1,
      "beschreibung": "git.amend",
      "risiko": "Der bestehende Commit wird ersetzt und erhält eine andere ID.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-commit",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git commit --amend"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.worktree",
      "version": 1,
      "beschreibung": "git.worktree",
      "risiko": "Ein zusätzlicher Arbeitsbaum wird entfernt.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-worktree",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git worktree remove ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.submodule",
      "version": 1,
      "beschreibung": "git.submodule",
      "risiko": "Eine Submodul-Arbeitskopie wird deaktiviert oder entfernt.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-submodule",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git submodule deinit -f ./x"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.gc",
      "version": 1,
      "beschreibung": "git.gc",
      "risiko": "Unreferenzierte Objekte können sofort aus der Wiederherstellung verschwinden.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-gc",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git gc --prune=now"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.reflog",
      "version": 1,
      "beschreibung": "git.reflog",
      "risiko": "Wiederherstellungsreferenzen werden entfernt.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-reflog",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git reflog expire --expire=now"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.filter",
      "version": 1,
      "beschreibung": "git.filter",
      "risiko": "Repository-Historie und Referenzen werden umgeschrieben.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-filter-branch",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git filter-branch --all"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "git.add",
      "version": 1,
      "beschreibung": "git.add",
      "risiko": "Breites Staging kann nicht vorgesehene Dateien oder Secrets aufnehmen.",
      "sicher": {
        "bash": "git status --short",
        "sh": "git status --short",
        "pwsh": "git status --short",
        "cmd": "git status --short"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://git-scm.com/docs/git-add",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "git add ."
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "sync.rsync",
      "version": 1,
      "beschreibung": "sync.rsync",
      "risiko": "Dateien, die in der Quelle fehlen, werden im Ziel gelöscht.",
      "sicher": {
        "bash": "rsync --dry-run --itemize-changes -- {{quelle}} {{ziel}}",
        "sh": "rsync --dry-run --itemize-changes -- {{quelle}} {{ziel}}"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {
        "quelle": "pfad",
        "ziel": "pfad"
      },
      "quelle": "https://download.samba.org/pub/rsync/rsync.1",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "rsync --delete source/ dest/"
      ],
      "negativ": [
        "rsync --delete --dry-run a b"
      ]
    },
    {
      "id": "sync.rclone",
      "version": 1,
      "beschreibung": "sync.rclone",
      "risiko": "Das Ziel wird dem Quellbestand angeglichen.",
      "sicher": {
        "bash": "rclone sync --dry-run -- {{quelle}} {{ziel}}",
        "pwsh": "rclone sync --dry-run -- {{quelle}} {{ziel}}"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {
        "quelle": "pfad",
        "ziel": "pfad"
      },
      "quelle": "https://rclone.org/commands/rclone_sync/",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "rclone sync source dest"
      ],
      "negativ": [
        "rclone sync --dry-run a b"
      ]
    },
    {
      "id": "sync.robocopy",
      "version": 1,
      "beschreibung": "sync.robocopy",
      "risiko": "Spiegeln oder Verschieben kann Ziel bzw. Quelle löschen.",
      "sicher": {
        "cmd": "robocopy {{quelle}} {{ziel}} /MIR /L",
        "pwsh": "robocopy {{quelle}} {{ziel}} /MIR /L"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {
        "quelle": "pfad",
        "ziel": "pfad"
      },
      "quelle": "https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/robocopy",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "robocopy source dest /MIR"
      ],
      "negativ": [
        "robocopy source dest /MIR /L"
      ]
    },
    {
      "id": "win.remove",
      "version": 1,
      "beschreibung": "win.remove",
      "risiko": "Dateien, Verzeichnisse oder Providerobjekte werden entfernt.",
      "sicher": {
        "pwsh": "Get-Item -LiteralPath {{ziel}} -Force"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/remove-item",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "Remove-Item \"$p\" -Recurse -Force"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "docker.prune",
      "version": 1,
      "beschreibung": "docker.prune",
      "risiko": "Container, Images, Caches oder Volumes werden bereinigt.",
      "sicher": {
        "bash": "docker ps -a",
        "sh": "docker ps -a",
        "pwsh": "docker ps -a",
        "cmd": "docker ps -a"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://docs.docker.com/reference/cli/docker/system/prune/",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "docker system prune -a"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "docker.volume",
      "version": 1,
      "beschreibung": "docker.volume",
      "risiko": "Persistente Volume-Daten werden entfernt.",
      "sicher": {
        "bash": "docker ps -a",
        "sh": "docker ps -a",
        "pwsh": "docker ps -a",
        "cmd": "docker ps -a"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://docs.docker.com/reference/cli/docker/volume/rm/",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "docker volume rm data"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "docker.remove",
      "version": 1,
      "beschreibung": "docker.remove",
      "risiko": "Container oder Images werden entfernt.",
      "sicher": {
        "bash": "docker ps -a",
        "sh": "docker ps -a",
        "pwsh": "docker ps -a",
        "cmd": "docker ps -a"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://docs.docker.com/reference/cli/docker/container/rm/",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "docker rm app"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "docker.compose",
      "version": 1,
      "beschreibung": "docker.compose",
      "risiko": "Services werden gestoppt; -v entfernt Projektvolumes.",
      "sicher": {
        "bash": "docker ps -a",
        "sh": "docker ps -a",
        "pwsh": "docker ps -a",
        "cmd": "docker ps -a"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://docs.docker.com/reference/cli/docker/compose/down/",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "docker compose down -v"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "db.sql",
      "version": 1,
      "beschreibung": "db.sql",
      "risiko": "SQL kann Tabellen, Datenbanken oder große Datenmengen entfernen bzw. ändern.",
      "sicher": {
        "bash": "pwd",
        "sh": "pwd",
        "pwsh": "Get-Location",
        "cmd": "cd"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://www.postgresql.org/docs/current/sql-delete.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "psql -c \"DELETE FROM t\""
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "db.redis",
      "version": 1,
      "beschreibung": "db.redis",
      "risiko": "Ein Redis-Datenbestand wird vollständig geleert.",
      "sicher": {
        "bash": "pwd",
        "sh": "pwd",
        "pwsh": "Get-Location",
        "cmd": "cd"
      },
      "danach": "Ziel, vorhandene Daten und Sicherung prüfen; danach eine konkrete geprüfte Variante wählen.",
      "platzhalter": {},
      "quelle": "https://redis.io/docs/latest/commands/flushall/",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "redis-cli FLUSHALL"
      ],
      "negativ": [
        "git status --short"
      ]
    },
    {
      "id": "inline.python",
      "version": 1,
      "beschreibung": "inline.python",
      "risiko": "Inline-Python entfernt Dateien oder schreibt vorhandene Dateiinhalte.",
      "sicher": {
        "bash": "find {{ziel}} -maxdepth 1 -print",
        "sh": "find {{ziel}} -maxdepth 1 -print",
        "pwsh": "Get-Item -LiteralPath {{ziel}} -Force",
        "cmd": "dir /a {{ziel}}"
      },
      "danach": "Die aufgelöste Ziel- und Trefferliste prüfen, Sicherung klären; anschließend eine auf diese Ziele begrenzte Variante verwenden.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://docs.python.org/3/library/shutil.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "python -c \"import shutil; shutil.rmtree('x')\""
      ],
      "negativ": [
        "python -c \"print('rmtree')\""
      ]
    },
    {
      "id": "inline.node",
      "version": 1,
      "beschreibung": "inline.node",
      "risiko": "Inline-Node entfernt Dateien oder schreibt vorhandene Dateiinhalte.",
      "sicher": {
        "bash": "find {{ziel}} -maxdepth 1 -print",
        "sh": "find {{ziel}} -maxdepth 1 -print",
        "pwsh": "Get-Item -LiteralPath {{ziel}} -Force",
        "cmd": "dir /a {{ziel}}"
      },
      "danach": "Die aufgelöste Ziel- und Trefferliste prüfen, Sicherung klären; anschließend eine auf diese Ziele begrenzte Variante verwenden.",
      "platzhalter": {
        "ziel": "pfad"
      },
      "quelle": "https://nodejs.org/api/fs.html",
      "status": "aktiv",
      "bereich": "global",
      "project": null,
      "os": [],
      "rechner": [],
      "positiv": [
        "node -e \"require('fs').rmSync('x')\""
      ],
      "negativ": [
        "node -e \"console.log('rmSync')\""
      ]
    }
  ],
  "risiko_verben": [
    {
      "id": "mutation",
      "muster": {
        "command": [
          "^(?:aws|gcloud|az|gsutil|kubectl|terraform|pulumi|rclone|docker|git|redis-cli|psql|mysql|systemctl|kill|pkill|killall|rm|mv|cp|chmod|chown|dd|mkfs.*|wipefs|sh|bash|pwsh|powershell|cmd|python[\\d.]*|node|eval|source|\\.)(?:\\.exe)?$"
        ],
        "argv_any": [
          "(?:^|[-_\\s])(?:delete|remove|terminate|destroy|purge|drop|truncate|flushall|flushdb|reset|clean|prune|kill|stop|disable|mask|isolate|mirror|sync|force|overwrite|restore|rebase|apply|rmtree|unlink|writeFile|rmSync)(?:$|[-_(\\s])",
          "^-r[fR]*$",
          "^-[fR]*r[fR]*$",
          "^--delete",
          "^of="
        ]
      },
      "status": "aktiv",
      "quelle": "P10-T35: unabhängige Risikowortklassifikation, kein DCG"
    },
    {
      "id": "direkte_mutation",
      "muster": {
        "command": [
          "^(?:kill|pkill|killall|mv|cp|chmod|chown|dd|mkfs.*|wipefs|rm|rmdir|del|erase|remove-item|eval|source)(?:\\.exe)?$"
        ]
      },
      "status": "aktiv",
      "quelle": "Eigene Risiko-Klassifikation nach GNU/Microsoft-Dokumentation."
    },
    {
      "id": "dynamisches_schreibziel",
      "muster": {
        "command": [],
        "umleitung": true,
        "target_regex": ".*\\$.*"
      },
      "quelle": "https://www.gnu.org/software/bash/manual/html_node/Redirections.html",
      "status": "aktiv"
    }
  ]
};
