// Seiteneffekt-Import: als ERSTEN Import eines Testskripts einbinden.
// ES-Module werden in Import-Reihenfolge ausgewertet, also laeuft die Schutzklausel vor
// packages/core/dist (das DATABASE_URL beim ersten Pool-Zugriff liest).
import { basename } from 'node:path'
import { testDbOderSkip } from './test-db-schutz.mjs'

testDbOderSkip(basename(process.argv[1] ?? 'test'))
