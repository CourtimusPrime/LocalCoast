import { describe, expect, it } from 'vitest';
import { getIsolatedWorldSource, getMainWorldSource } from '../dist/index.js';

describe('page-agent artifact', () => {
  it('substitutes per-target nonce binding names into both worlds', () => {
    const main = getMainWorldSource('__lc_nonce_abc123');
    expect(main).toContain('__lc_nonce_abc123');
    expect(main).not.toContain('__LC_BINDING__');

    const isolated = getIsolatedWorldSource('__lc_nonce_def456');
    expect(isolated).toContain('__lc_nonce_def456');
    expect(isolated).not.toContain('__LC_ISO_BINDING__');
  });

  it('bundles are standalone IIFEs with no module syntax', () => {
    const main = getMainWorldSource('x');
    expect(main).not.toMatch(/^\s*import /m);
    expect(main).not.toMatch(/module\.exports/);
  });
});
