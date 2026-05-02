/**
 * MODUL: HTTP-Pattern-Konstanten fuer Route-Detection.
 * ZWECK: Geteilt von allen Sprach-Parsern die Web-Framework-Routen erkennen
 *        sollen (TypeScript/Fastify/Express, Python/Flask, Go/gin, etc.).
 * Output-Schema: parsed-Symbol mit symbol_type "route", name "<METHOD> <path>",
 * value=path, params=[METHOD, ...].
 */

/** HTTP-Verben die als Routen-Methoden erkannt werden. Lower-case fuer Matching. */
export const HTTP_VERBS: ReadonlySet<string> = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all',
]);

/**
 * NestJS-Decorator-Namen → HTTP-Verb. Auch von TS-Parser genutzt fuer
 * `@Get('/x')`-Pattern. Andere Sprachen mit aehnlichen Decorators (Python
 * FastAPI nutzt @app.get statt @Get) brauchen eigene Maps.
 */
export const NEST_DECORATORS: Readonly<Record<string, string>> = {
  Get: 'get', Post: 'post', Put: 'put', Patch: 'patch',
  Delete: 'delete', Head: 'head', Options: 'options', All: 'all',
};

/**
 * Spring-/Java-Decorator-Namen → HTTP-Verb.
 */
export const SPRING_DECORATORS: Readonly<Record<string, string>> = {
  GetMapping: 'get', PostMapping: 'post', PutMapping: 'put',
  PatchMapping: 'patch', DeleteMapping: 'delete',
};

/**
 * ASP.NET-Attribute-Namen → HTTP-Verb. Erkennt [HttpGet], [HttpPost] etc.
 */
export const ASPNET_ATTRIBUTES: Readonly<Record<string, string>> = {
  HttpGet: 'get', HttpPost: 'post', HttpPut: 'put',
  HttpPatch: 'patch', HttpDelete: 'delete',
};

/**
 * Hilfsfunktion: Format einen Routen-Symbol-Namen aus Method + Path.
 * Konsistent ueber alle Sprachen. Beispiel: "GET /api/users".
 */
export function formatRouteName(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Pruefen ob ein String ein gueltiger HTTP-Pfad sein koennte (mit "/" beginnt).
 * Filtert false-positives wie Array.get(0).
 */
export function isLikelyHttpPath(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.length > 0 && s.startsWith('/');
}
