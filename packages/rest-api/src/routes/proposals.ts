/**
 * Synapse API - Proposals Routes
 * Schattenvorschlaege: Code-Aenderungsvorschlaege pro Projekt
 */

import { FastifyInstance } from 'fastify';
import {
  createProposal,
  getProposal,
  listProposals,
  updateProposalStatus,
  deleteProposal,
  searchProposals,
} from '@synapse/core';

export async function proposalRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/projects/:name/proposals
   * Neuen Vorschlag erstellen
   */
  fastify.post<{
    Params: { name: string };
    Body: {
      filePath: string;
      suggestedContent: string;
      description: string;
      author: string;
      tags?: string[];
    };
  }>('/api/projects/:name/proposals', async (request, reply) => {
    const { name } = request.params;
    const { filePath, suggestedContent, description, author, tags = [] } = request.body;

    if (!filePath || !suggestedContent || !description || !author) {
      return reply.status(400).send({
        success: false,
        error: { message: 'filePath, suggestedContent, description und author sind erforderlich' },
      });
    }

    try {
      const proposal = await createProposal(name, filePath, suggestedContent, description, author, tags);

      return {
        success: true,
        proposal,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/proposals
   * Alle Vorschlaege eines Projekts auflisten (Lightweight: ohne suggestedContent)
   */
  fastify.get<{
    Params: { name: string };
    Querystring: { status?: string };
  }>('/api/projects/:name/proposals', async (request, reply) => {
    const { name } = request.params;
    const { status } = request.query;

    try {
      const proposals = await listProposals(
        name,
        status as 'pending' | 'reviewed' | 'accepted' | 'rejected' | undefined
      );

      return {
        success: true,
        proposals,
        count: proposals.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/proposals/:id
   * Einzelnen Vorschlag abrufen (mit vollem suggestedContent)
   */
  fastify.get<{
    Params: { name: string; id: string };
  }>('/api/projects/:name/proposals/:id', async (request, reply) => {
    const { name, id } = request.params;

    try {
      const proposal = await getProposal(name, id);

      if (!proposal) {
        return reply.status(404).send({
          success: false,
          error: { message: `Proposal "${id}" nicht gefunden in Projekt "${name}"` },
        });
      }

      return {
        success: true,
        proposal,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * PUT /api/projects/:name/proposals/:id/status
   * Status eines Vorschlags aendern
   */
  fastify.put<{
    Params: { name: string; id: string };
    Body: { status: 'reviewed' | 'accepted' | 'rejected' };
  }>('/api/projects/:name/proposals/:id/status', async (request, reply) => {
    const { name, id } = request.params;
    const { status } = request.body;

    if (!status || !['reviewed', 'accepted', 'rejected'].includes(status)) {
      return reply.status(400).send({
        success: false,
        error: { message: 'status muss "reviewed", "accepted" oder "rejected" sein' },
      });
    }

    try {
      const proposal = await updateProposalStatus(name, id, status);

      if (!proposal) {
        return reply.status(404).send({
          success: false,
          error: { message: `Proposal "${id}" nicht gefunden in Projekt "${name}"` },
        });
      }

      return {
        success: true,
        proposal,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * DELETE /api/projects/:name/proposals/:id
   * Vorschlag loeschen
   */
  fastify.delete<{
    Params: { name: string; id: string };
  }>('/api/projects/:name/proposals/:id', async (request, reply) => {
    const { name, id } = request.params;

    try {
      const deleted = await deleteProposal(name, id);

      if (!deleted) {
        return reply.status(404).send({
          success: false,
          error: { message: `Proposal "${id}" nicht gefunden in Projekt "${name}"` },
        });
      }

      return {
        success: true,
        message: `Proposal "${id}" geloescht`,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * POST /api/projects/:name/proposals/search
   * Vorschlaege semantisch durchsuchen
   */
  fastify.post<{
    Params: { name: string };
    Body: { query: string; limit?: number };
  }>('/api/projects/:name/proposals/search', async (request, reply) => {
    const { name } = request.params;
    const { query, limit = 10 } = request.body;

    if (!query) {
      return reply.status(400).send({
        success: false,
        error: { message: 'query ist erforderlich' },
      });
    }

    try {
      const results = await searchProposals(query, name, limit);

      return {
        success: true,
        results,
        count: results.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
