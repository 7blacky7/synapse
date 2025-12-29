/**
 * Synapse API - Error Handler
 */

import { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Globaler Error Handler
 */
export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  console.error(`[Synapse API] Fehler:`, error);

  const statusCode = error.statusCode || 500;

  reply.status(statusCode).send({
    success: false,
    error: {
      message: error.message,
      code: error.code || 'INTERNAL_ERROR',
    },
  });
}
