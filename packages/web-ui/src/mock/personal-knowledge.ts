export type KnowledgeSection = 'user-memories' | 'personal-artifacts';

export interface PersonalMemory {
  id: string;
  title: string;
  category: string;
  content: string;
  tags: string[];
  priority: 'Niedrig' | 'Normal' | 'Hoch' | 'Kritisch';
  sourceType: 'Manuell' | 'Gespräch' | 'Artefakt' | 'Importiert';
  sourceLabel: string;
  createdAt: string;
  lastUsed: string;
  artifactIds: string[];
  createdBy: 'Benutzer' | 'Main-Agent';
}

export type PersonalArtifactStatus =
  | 'Neu'
  | 'Wartet auf Nachtanalyse'
  | 'Wird analysiert'
  | 'Verarbeitet'
  | 'Archiviert'
  | 'Analyse möglich'
  | 'Bereit';

export interface ArtifactUsageEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  result: string;
}

export interface PersonalArtifact {
  id: string;
  title: string;
  kind: string;
  category: string;
  tags: string[];
  origin: string;
  addedAt: string;
  preview: string;
  linkedMemoryIds: string[];
  status: PersonalArtifactStatus;
  size?: string;
  serverPath?: string;
  lastAccessedAt?: string;
  lastAnalyzedAt?: string;
  derivedInformation?: string[];
  usageHistory?: ArtifactUsageEvent[];
}

export const memoryCategories = ['Alle', 'Erfahrungen', 'Arbeitsweisen', 'Präferenzen', 'Entscheidungen', 'Technische Erfahrungen', 'Kommunikation', 'Ideen', 'Wichtige Hinweise'];

export const initialPersonalMemories: PersonalMemory[] = [
  {
    id: 'mem-ui-first',
    title: 'Bedienbare UI vor Backend-Verdrahtung',
    category: 'Arbeitsweisen',
    content: 'Bei größeren Synapse-Änderungen möchte der Benutzer zuerst eine vollständig bedienbare Mock-UI prüfen, bevor Backend-Funktionen produktiv verdrahtet werden.',
    tags: ['synapse', 'ui1-ui3', 'arbeitsablauf'],
    priority: 'Hoch',
    sourceType: 'Gespräch',
    sourceLabel: 'Gespräch vom 16.08.2026',
    createdAt: '16.08.2026 · 12:42',
    lastUsed: 'heute · Main-Agent',
    artifactIds: ['artifact-mail'],
    createdBy: 'Main-Agent',
  },
  {
    id: 'mem-code-intel',
    title: 'Code Intel taktisch verwenden',
    category: 'Technische Erfahrungen',
    content: 'Code Intel ist die primäre strukturierte Codesuche. Semantische Suche wird erst als zweite, gezielte Ausweichsuche eingesetzt.',
    tags: ['code-intel', 'synapse-tools', 'suche'],
    priority: 'Kritisch',
    sourceType: 'Artefakt',
    sourceLabel: 'Notiz: Synapse Werkzeugregeln',
    createdAt: '16.08.2026 · 09:38',
    lastUsed: 'heute · Main-Agent',
    artifactIds: ['artifact-tool-rules'],
    createdBy: 'Benutzer',
  },
  {
    id: 'mem-design',
    title: 'Control-Plane Gestaltung',
    category: 'Präferenzen',
    content: 'Bevorzugt wird ein professionelles Hell-/Dunkel-Design mit Orange als Akzentfarbe, hoher Informationsdichte und ohne dekorative Platzhalterkarten.',
    tags: ['design', 'orange', 'control-plane'],
    priority: 'Hoch',
    sourceType: 'Gespräch',
    sourceLabel: 'UI-Abstimmung',
    createdAt: '16.08.2026 · 09:12',
    lastUsed: 'vor 34 min · UI-Koordinator',
    artifactIds: ['artifact-ui-shot'],
    createdBy: 'Main-Agent',
  },
  {
    id: 'mem-project-rule',
    title: 'Ein Projekt bleibt ein UI-Objekt',
    category: 'Entscheidungen',
    content: 'Memories, Thoughts, Tasks, Channels, Agenten und Workspaces sind Inhalte eines Projekts und erzeugen keine zusätzlichen Einträge in der Projektübersicht.',
    tags: ['projekte', 'navigation', 'architektur'],
    priority: 'Kritisch',
    sourceType: 'Manuell',
    sourceLabel: 'Benutzervorgabe',
    createdAt: '16.08.2026 · 08:51',
    lastUsed: 'heute · Main-Agent',
    artifactIds: ['artifact-mail'],
    createdBy: 'Benutzer',
  },
];

export const initialPersonalArtifacts: PersonalArtifact[] = [
  {
    id: 'artifact-tool-rules',
    title: 'synapse-werkzeugregeln.txt',
    kind: 'Textdokument',
    category: 'Technische Dokumente',
    tags: ['code-intel', 'files-batch'],
    origin: 'Hauptagenten-Chat',
    addedAt: '16.08.2026 · 09:35',
    preview: 'Code Intel zuerst strukturiert einsetzen. Änderungen ausschließlich über die vorgesehenen Synapse-Dateiwerkzeuge planen und atomar schreiben.',
    linkedMemoryIds: ['mem-code-intel'],
    status: 'Verarbeitet',
    size: '18,4 KB',
    serverPath: '/mnt/user/synapse-private/main-agent/artifacts/2026/08/artifact-tool-rules.txt',
    lastAccessedAt: '16.08.2026 · 13:41',
    lastAnalyzedAt: '16.08.2026 · 09:38',
    derivedInformation: ['Primäre Codesuche: Code Intel', 'Semantische Suche nur gezielt als zweite Stufe', 'Änderungen atomar über Synapse-Dateiwerkzeuge'],
    usageHistory: [
      { id: 'u1', at: '13:41', actor: 'Main-Agent', action: 'Gelesen', result: 'Für UI-Auftrag verwendet' },
      { id: 'u2', at: '09:38', actor: 'Main-Agent', action: 'Analysiert', result: '1 Memory abgeleitet' },
      { id: 'u3', at: '09:35', actor: 'Synapse API', action: 'Übernommen', result: 'Privates Volume · Mock' },
    ],
  },
  {
    id: 'artifact-ui-shot',
    title: 'synapse-control-plane.png',
    kind: 'Bild / Screenshot',
    category: 'Bilder',
    tags: ['webui', 'layout', 'orange'],
    origin: 'Hauptagenten-Chat',
    addedAt: '16.08.2026 · 10:53',
    preview: '/mnt/user/synapse-private/main-agent/artifacts/2026/08/synapse-control-plane.png',
    linkedMemoryIds: ['mem-design'],
    status: 'Wird analysiert',
    size: '612 KB',
    serverPath: '/mnt/user/synapse-private/main-agent/artifacts/2026/08/synapse-control-plane.png',
    lastAccessedAt: '16.08.2026 · 13:48',
    lastAnalyzedAt: 'Analyse läuft · Mock-Stream',
    derivedInformation: ['Dunkle Control-Plane', 'Orange als primäre Akzentfarbe', 'Hohe Informationsdichte'],
    usageHistory: [
      { id: 'u4', at: '13:48', actor: 'Main-Agent', action: 'Vorschau geöffnet', result: 'UI-Referenz geprüft' },
      { id: 'u5', at: '10:54', actor: 'Main-Agent', action: 'Analyse gestartet', result: 'Mock-Verarbeitung läuft' },
      { id: 'u6', at: '10:53', actor: 'Synapse API', action: 'Übernommen', result: 'Privates Volume · Mock' },
    ],
  },
  {
    id: 'artifact-mail',
    title: 'abstimmung-ui.eml',
    kind: 'E-Mail-Export',
    category: 'Kommunikation',
    tags: ['email', 'arbeitsweise'],
    origin: 'Hauptagenten-Chat',
    addedAt: '15.08.2026 · 18:20',
    preview: 'Vor produktiver Umsetzung soll der vollständige Bedienablauf gemeinsam geprüft und bestätigt werden.',
    linkedMemoryIds: ['mem-ui-first', 'mem-project-rule', 'mem-design'],
    status: 'Verarbeitet',
    size: '84,7 KB',
    serverPath: '/mnt/user/synapse-private/main-agent/artifacts/2026/08/abstimmung-ui.eml',
    lastAccessedAt: '16.08.2026 · 12:42',
    lastAnalyzedAt: '16.08.2026 · 12:39',
    derivedInformation: ['Mock-UI vor Backend-Verdrahtung', 'Projektobjekte nicht vervielfachen', 'Control-Plane-Design bevorzugt'],
    usageHistory: [
      { id: 'u7', at: '12:42', actor: 'Main-Agent', action: 'Memories verknüpft', result: '3 Memories erzeugt' },
      { id: 'u8', at: '12:39', actor: 'Main-Agent', action: 'Analysiert', result: '3 relevante Informationen erkannt' },
      { id: 'u9', at: 'gestern', actor: 'Synapse API', action: 'Übernommen', result: 'Privates Volume · Mock' },
    ],
  },
  {
    id: 'artifact-night',
    title: 'wartungsnotiz.pdf',
    kind: 'PDF',
    category: 'Notizen',
    tags: [],
    origin: 'Hauptagenten-Chat',
    addedAt: '16.08.2026 · 14:18',
    preview: 'Die Datei wurde angenommen und für die spätere Nachtanalyse vorgemerkt.',
    linkedMemoryIds: [],
    status: 'Wartet auf Nachtanalyse',
    size: '1,8 MB',
    serverPath: '/mnt/user/synapse-private/main-agent/artifacts/2026/08/wartungsnotiz.pdf',
    lastAccessedAt: 'noch nie',
    lastAnalyzedAt: 'noch nicht analysiert',
    derivedInformation: [],
    usageHistory: [
      { id: 'u10', at: '14:18', actor: 'Main-Agent', action: 'Vorgemerkt', result: 'Nachtanalyse' },
      { id: 'u11', at: '14:18', actor: 'Synapse API', action: 'Übernommen', result: 'Privates Volume · Mock' },
    ],
  },
  {
    id: 'artifact-new',
    title: 'leitstellen-skizze.jpg',
    kind: 'Bild / Screenshot',
    category: 'Bilder',
    tags: [],
    origin: 'Hauptagenten-Chat',
    addedAt: '16.08.2026 · 14:27',
    preview: '/mnt/user/synapse-private/main-agent/artifacts/2026/08/leitstellen-skizze.jpg',
    linkedMemoryIds: [],
    status: 'Neu',
    size: '2,3 MB',
    serverPath: '/mnt/user/synapse-private/main-agent/artifacts/2026/08/leitstellen-skizze.jpg',
    lastAccessedAt: 'noch nie',
    lastAnalyzedAt: 'noch nicht analysiert',
    derivedInformation: [],
    usageHistory: [
      { id: 'u12', at: '14:27', actor: 'Synapse API', action: 'Übernommen', result: 'Neu · noch nicht eingeordnet' },
    ],
  },
  {
    id: 'artifact-archive',
    title: 'alte-gespraechsnotiz.md',
    kind: 'Textdokument',
    category: 'Gesprächsnotizen',
    tags: ['archiv'],
    origin: 'Hauptagenten-Chat',
    addedAt: '02.08.2026 · 21:06',
    preview: 'Ältere Gesprächsnotiz; bleibt als kontrollierbares Original im privaten Archiv.',
    linkedMemoryIds: [],
    status: 'Archiviert',
    size: '9,2 KB',
    serverPath: '/mnt/user/synapse-private/main-agent/artifacts/2026/08/alte-gespraechsnotiz.md',
    lastAccessedAt: '10.08.2026 · 02:11',
    lastAnalyzedAt: '03.08.2026 · 02:03',
    derivedInformation: ['Keine dauerhafte Memory-Ableitung erforderlich'],
    usageHistory: [
      { id: 'u13', at: '10.08.', actor: 'Benutzer', action: 'Archiviert', result: 'Original bleibt erhalten' },
      { id: 'u14', at: '03.08.', actor: 'Main-Agent', action: 'Analysiert', result: 'Keine Memory-Ableitung' },
    ],
  },
];
