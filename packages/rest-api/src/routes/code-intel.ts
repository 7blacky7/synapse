/**
 * Synapse API - Code Intel Routes
 * Code-Analyse und Navigation fuer Projektdateien
 */

import { FastifyInstance } from 'fastify';
import {
  getProjectTree,
  getFunctions,
  getVariables,
  getSymbols,
  getReferences,
  fullTextSearchCode,
  getFileContent,
} from '@synapse/core';

export async function codeIntelRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/projects/:name/code-intel/tree
   * Verzeichnisbaum eines Projekts abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: {
      path?: string;
      recursive?: string;
      depth?: string;
      show_lines?: string;
      show_counts?: string;
      show_comments?: string;
      show_functions?: string;
      show_imports?: string;
      file_type?: string;
    };
  }>('/api/projects/:name/code-intel/tree', async (request, reply) => {
    const { name } = request.params;
    const {
      path,
      recursive,
      depth,
      show_lines,
      show_counts,
      show_comments,
      show_functions,
      show_imports,
      file_type,
    } = request.query;

    try {
      const result = await getProjectTree(name, {
        path,
        recursive: recursive !== undefined ? recursive === 'true' : true,
        depth: depth !== undefined ? parseInt(depth, 10) : undefined,
        show_lines: show_lines !== undefined ? show_lines === 'true' : true,
        show_counts: show_counts !== undefined ? show_counts === 'true' : true,
        show_comments: show_comments === 'true',
        show_functions: show_functions === 'true',
        show_imports: show_imports === 'true',
        file_type,
      });

      return {
        success: true,
        tree: result,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/code-intel/functions
   * Funktionen eines Projekts oder einer Datei abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: {
      file_path?: string;
      name?: string;
      exported_only?: string;
    };
  }>('/api/projects/:name/code-intel/functions', async (request, reply) => {
    const { name } = request.params;
    const { file_path, name: fnName, exported_only } = request.query;

    try {
      const result = await getFunctions(name, file_path, fnName, exported_only === 'true');

      return {
        success: true,
        functions: result,
        count: result.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/code-intel/variables
   * Variablen eines Projekts oder einer Datei abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: {
      file_path?: string;
      name?: string;
      with_values?: string;
    };
  }>('/api/projects/:name/code-intel/variables', async (request, reply) => {
    const { name } = request.params;
    const { file_path, name: varName, with_values } = request.query;

    try {
      const result = await getVariables(name, file_path, varName, with_values === 'true');

      return {
        success: true,
        variables: result,
        count: result.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/code-intel/symbols
   * Symbole eines Projekts oder einer Datei abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: {
      symbol_type: string;
      file_path?: string;
      name?: string;
    };
  }>('/api/projects/:name/code-intel/symbols', async (request, reply) => {
    const { name } = request.params;
    const { symbol_type, file_path, name: symName } = request.query;

    if (!symbol_type) {
      return reply.status(400).send({
        success: false,
        error: { message: 'symbol_type ist erforderlich' },
      });
    }

    try {
      const result = await getSymbols(name, symbol_type, file_path, symName);

      return {
        success: true,
        symbols: result,
        count: result.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/code-intel/references
   * Referenzen eines Symbols abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: {
      name: string;
    };
  }>('/api/projects/:name/code-intel/references', async (request, reply) => {
    const { name } = request.params;
    const { name: refName } = request.query;

    if (!refName) {
      return reply.status(400).send({
        success: false,
        error: { message: 'name ist erforderlich' },
      });
    }

    try {
      const result = await getReferences(name, refName);

      return {
        success: true,
        definition: result.definition,
        references: result.references,
        total_files: result.total_files,
        total_references: result.total_references,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/code-intel/search
   * Volltext-Suche im Code
   */
  fastify.get<{
    Params: { name: string };
    Querystring: {
      query: string;
      file_type?: string;
      limit?: string;
    };
  }>('/api/projects/:name/code-intel/search', async (request, reply) => {
    const { name } = request.params;
    const { query, file_type, limit } = request.query;

    if (!query) {
      return reply.status(400).send({
        success: false,
        error: { message: 'query ist erforderlich' },
      });
    }

    try {
      const result = await fullTextSearchCode(
        name,
        query,
        file_type,
        limit !== undefined ? parseInt(limit, 10) : undefined
      );

      return {
        success: true,
        results: result,
        count: result.length,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });

  /**
   * GET /api/projects/:name/code-intel/file
   * Inhalt einer Datei abrufen
   */
  fastify.get<{
    Params: { name: string };
    Querystring: {
      path: string;
    };
  }>('/api/projects/:name/code-intel/file', async (request, reply) => {
    const { name } = request.params;
    const { path } = request.query;

    if (!path) {
      return reply.status(400).send({
        success: false,
        error: { message: 'path ist erforderlich' },
      });
    }

    try {
      const result = await getFileContent(name, path);

      if (!result) {
        return reply.status(404).send({
          success: false,
          error: { message: `Datei "${path}" nicht gefunden in Projekt "${name}"` },
        });
      }

      return {
        success: true,
        file: result,
      };
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: { message: String(error) },
      });
    }
  });
}
