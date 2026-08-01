import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';

const SYNAPSE_QDRANT_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function embeddingContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function deterministicChunkPointId(
  project: string,
  filePath: string,
  chunkIndex: number,
  content: string,
): string {
  const shortHash = embeddingContentHash(content).slice(0, 16);
  return uuidv5(`${project}:${filePath}:${chunkIndex}:${shortHash}`, SYNAPSE_QDRANT_NS);
}
