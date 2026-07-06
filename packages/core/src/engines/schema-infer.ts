/**
 * Schema inference engine (infra #13): accumulate a shape per endpoint from
 * observed response bodies; render as JSON-Schema-ish; validate later samples
 * against the accumulated shape to flag contract drift.
 */

export type Shape =
  | { kind: 'primitive'; types: Set<string>; nullable: boolean }
  | { kind: 'object'; fields: Map<string, { shape: Shape; optional: boolean }>; nullable: boolean }
  | { kind: 'array'; items: Shape | null; nullable: boolean };

export function inferShape(value: unknown): Shape {
  if (value === null || value === undefined) {
    return { kind: 'primitive', types: new Set(), nullable: true };
  }
  if (Array.isArray(value)) {
    let items: Shape | null = null;
    for (const v of value.slice(0, 50)) {
      items = items ? mergeShape(items, inferShape(v)) : inferShape(v);
    }
    return { kind: 'array', items, nullable: false };
  }
  if (typeof value === 'object') {
    const fields = new Map<string, { shape: Shape; optional: boolean }>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields.set(k, { shape: inferShape(v), optional: false });
    }
    return { kind: 'object', fields, nullable: false };
  }
  return { kind: 'primitive', types: new Set([typeof value]), nullable: false };
}

export function mergeShape(a: Shape, b: Shape): Shape {
  if (a.kind === 'primitive' && a.types.size === 0) return { ...b, nullable: true };
  if (b.kind === 'primitive' && b.types.size === 0) return { ...a, nullable: true };
  if (a.kind !== b.kind) {
    // Mixed kinds: degrade to an any-ish primitive union.
    return { kind: 'primitive', types: new Set(['mixed']), nullable: a.nullable || b.nullable };
  }
  if (a.kind === 'primitive' && b.kind === 'primitive') {
    return {
      kind: 'primitive',
      types: new Set([...a.types, ...b.types]),
      nullable: a.nullable || b.nullable,
    };
  }
  if (a.kind === 'array' && b.kind === 'array') {
    return {
      kind: 'array',
      items: a.items && b.items ? mergeShape(a.items, b.items) : (a.items ?? b.items),
      nullable: a.nullable || b.nullable,
    };
  }
  const ao = a as Extract<Shape, { kind: 'object' }>;
  const bo = b as Extract<Shape, { kind: 'object' }>;
  const fields = new Map<string, { shape: Shape; optional: boolean }>();
  for (const key of new Set([...ao.fields.keys(), ...bo.fields.keys()])) {
    const fa = ao.fields.get(key);
    const fb = bo.fields.get(key);
    if (fa && fb) {
      fields.set(key, { shape: mergeShape(fa.shape, fb.shape), optional: fa.optional || fb.optional });
    } else {
      const f = (fa ?? fb)!;
      fields.set(key, { shape: f.shape, optional: true });
    }
  }
  return { kind: 'object', fields, nullable: ao.nullable || bo.nullable };
}

export function shapeToJsonSchema(shape: Shape): Record<string, unknown> {
  switch (shape.kind) {
    case 'primitive': {
      const types = [...shape.types].map((t) => (t === 'mixed' ? 'object' : t));
      if (shape.nullable) types.push('null');
      return types.length === 1 ? { type: types[0] } : { type: types.length ? types : ['null'] };
    }
    case 'array':
      return {
        type: shape.nullable ? ['array', 'null'] : 'array',
        items: shape.items ? shapeToJsonSchema(shape.items) : {},
      };
    case 'object': {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, f] of shape.fields) {
        properties[k] = shapeToJsonSchema(f.shape);
        if (!f.optional) required.push(k);
      }
      return {
        type: shape.nullable ? ['object', 'null'] : 'object',
        properties,
        ...(required.length ? { required: required.sort() } : {}),
      };
    }
  }
}

/** Validate a value against an accumulated shape → human-readable problems. */
export function validateAgainstShape(value: unknown, shape: Shape, path = '$'): string[] {
  const problems: string[] = [];
  check(value, shape, path, problems);
  return problems.slice(0, 20);
}

function check(value: unknown, shape: Shape, path: string, problems: string[]): void {
  if (problems.length >= 20) return;
  if (value === null || value === undefined) {
    if (!shape.nullable) problems.push(`${path}: unexpected null`);
    return;
  }
  switch (shape.kind) {
    case 'primitive':
      if (shape.types.size > 0 && !shape.types.has('mixed') && !shape.types.has(typeof value)) {
        problems.push(`${path}: ${typeof value}, expected ${[...shape.types].join('|')}`);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${path}: ${typeof value}, expected array`);
        return;
      }
      if (shape.items) {
        for (let i = 0; i < Math.min(value.length, 20); i++) {
          check(value[i], shape.items, `${path}[${i}]`, problems);
        }
      }
      return;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${path}: ${Array.isArray(value) ? 'array' : typeof value}, expected object`);
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const [k, f] of shape.fields) {
        if (!(k in obj)) {
          if (!f.optional) problems.push(`${path}.${k}: missing required field`);
        } else {
          check(obj[k], f.shape, `${path}.${k}`, problems);
        }
      }
      return;
    }
  }
}

/** "GET /api/users/123?x=1" → "GET /api/users/:id" — numeric/uuid segments normalized. */
export function endpointKey(method: string, url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split('?')[0] ?? url;
  }
  const normalized = pathname
    .split('/')
    .map((seg) =>
      /^\d+$/.test(seg) || /^[0-9a-f-]{8,}$/i.test(seg) ? ':id' : seg,
    )
    .join('/');
  return `${method.toUpperCase()} ${normalized}`;
}
