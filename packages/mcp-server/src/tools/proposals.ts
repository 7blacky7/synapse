/**
 * Synapse MCP - Proposal Tools
 * Schattenvorschlaege lesen, bewerten und loeschen
 */

import {
  listProposals as coreListProposals,
  getProposal as coreGetProposal,
  updateProposalStatus as coreUpdateProposalStatus,
  deleteProposal as coreDeleteProposal,
  searchProposals as coreSearchProposals,
  Proposal,
  ProposalPayload,
  SearchResult,
} from '@synapse/core';

/**
 * Listet alle Proposals eines Projekts auf (nur Metadaten, kein Content)
 */
export async function listProposalsWrapper(
  project: string,
  status?: string
): Promise<string> {
  try {
    const proposals = await coreListProposals(
      project,
      status as Proposal['status'] | undefined
    );

    if (proposals.length === 0) {
      const statusHint = status ? ` mit Status "${status}"` : '';
      return `Keine Vorschlaege${statusHint} in Projekt "${project}" gefunden.`;
    }

    const lines = proposals.map((p, i) => {
      const tags = p.tags.length > 0 ? ` [${p.tags.join(', ')}]` : '';
      return [
        `${i + 1}. ${p.description}`,
        `   ID: ${p.id}`,
        `   Datei: ${p.filePath}`,
        `   Status: ${p.status} | Autor: ${p.author}${tags}`,
        `   Erstellt: ${p.createdAt} | Aktualisiert: ${p.updatedAt}`,
      ].join('\n');
    });

    const statusHint = status ? ` (Filter: ${status})` : '';
    return `${proposals.length} Vorschlaege in "${project}"${statusHint}:\n\n${lines.join('\n\n')}`;
  } catch (error) {
    return `Fehler beim Auflisten der Vorschlaege: ${error}`;
  }
}

/**
 * Holt einen einzelnen Proposal mit vollem suggestedContent
 */
export async function getProposalWrapper(
  project: string,
  id: string
): Promise<string> {
  try {
    const proposal = await coreGetProposal(project, id);

    if (!proposal) {
      return `Vorschlag "${id}" nicht gefunden in Projekt "${project}".`;
    }

    const tags = proposal.tags.length > 0 ? `Tags: ${proposal.tags.join(', ')}` : 'Tags: keine';

    return [
      `Vorschlag: ${proposal.description}`,
      `ID: ${proposal.id}`,
      `Datei: ${proposal.filePath}`,
      `Status: ${proposal.status} | Autor: ${proposal.author}`,
      tags,
      `Erstellt: ${proposal.createdAt} | Aktualisiert: ${proposal.updatedAt}`,
      '',
      '--- Vorgeschlagener Inhalt ---',
      proposal.suggestedContent,
    ].join('\n');
  } catch (error) {
    return `Fehler beim Abrufen des Vorschlags: ${error}`;
  }
}

/**
 * Aktualisiert den Status eines Proposals
 */
export async function updateProposalStatusWrapper(
  project: string,
  id: string,
  status: string
): Promise<string> {
  try {
    const updated = await coreUpdateProposalStatus(
      project,
      id,
      status as Proposal['status']
    );

    if (!updated) {
      return `Vorschlag "${id}" nicht gefunden in Projekt "${project}".`;
    }

    return `Status von Vorschlag "${id}" geaendert zu "${status}".\nDatei: ${updated.filePath}\nBeschreibung: ${updated.description}`;
  } catch (error) {
    return `Fehler beim Aktualisieren des Status: ${error}`;
  }
}

/**
 * Aktualisiert einen Proposal (einzelne Felder aenderbar)
 */
export async function updateProposalTool(
  project: string,
  id: string,
  changes: { content?: string; suggestedContent?: string; status?: string }
): Promise<{
  success: boolean;
  proposal: Proposal | null;
  message: string;
}> {
  try {
    const { updateProposal } = await import('@synapse/core');
    const proposal = await updateProposal(project, id, changes);

    if (!proposal) {
      return {
        success: false,
        proposal: null,
        message: `Vorschlag "${id}" nicht gefunden in Projekt "${project}"`,
      };
    }

    const changedFields = Object.keys(changes).filter(k => changes[k as keyof typeof changes] !== undefined);
    return {
      success: true,
      proposal,
      message: `Vorschlag "${id}" aktualisiert (${changedFields.join(', ')})`,
    };
  } catch (error) {
    return {
      success: false,
      proposal: null,
      message: `Fehler beim Aktualisieren des Vorschlags: ${error}`,
    };
  }
}

/**
 * Loescht einen Proposal
 */
export async function deleteProposalWrapper(
  project: string,
  id: string
): Promise<string> {
  try {
    const deleted = await coreDeleteProposal(project, id);

    if (!deleted.success) {
      return `Vorschlag "${id}" nicht gefunden in Projekt "${project}".`;
    }

    const warningInfo = deleted.warning ? ` (Warning: ${deleted.warning})` : '';
    return `Vorschlag "${id}" erfolgreich geloescht aus Projekt "${project}".${warningInfo}`;
  } catch (error) {
    return `Fehler beim Loeschen des Vorschlags: ${error}`;
  }
}

/**
 * Durchsucht Proposals semantisch
 */
export async function searchProposalsWrapper(
  query: string,
  project: string,
  limit: number = 10
): Promise<string> {
  try {
    const results = await coreSearchProposals(query, project, limit);

    if (results.length === 0) {
      const projectHint = project ? ` in Projekt "${project}"` : '';
      return `Keine Vorschlaege${projectHint} gefunden fuer: "${query}"`;
    }

    const lines = results.map((r, i) => {
      const p = r.payload;
      const tags = p.tags && p.tags.length > 0 ? ` [${p.tags.join(', ')}]` : '';
      return [
        `${i + 1}. ${p.description} (Score: ${r.score.toFixed(3)})`,
        `   ID: ${r.id}`,
        `   Datei: ${p.file_path}`,
        `   Status: ${p.status} | Autor: ${p.author}${tags}`,
        `   Projekt: ${p.project}`,
      ].join('\n');
    });

    const projectHint = project ? ` in "${project}"` : '';
    return `${results.length} Ergebnisse${projectHint} fuer "${query}":\n\n${lines.join('\n\n')}`;
  } catch (error) {
    return `Fehler bei der Suche: ${error}`;
  }
}
