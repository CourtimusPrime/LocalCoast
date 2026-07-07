import { describe, expect, it } from 'vitest';
import { classifyDeps, isTechnicalName } from '../src/main/inspector.js';

describe('classifyDeps', () => {
  it('classifies meta-frameworks as fullstack', () => {
    expect(classifyDeps({ next: '14.0.0' })).toMatchObject({
      serverType: 'fullstack',
      frameworkId: 'next',
    });
    expect(classifyDeps({ '@sveltejs/kit': '2.0.0' }).serverType).toBe('fullstack');
    expect(classifyDeps({ nuxt: '3' }).serverType).toBe('fullstack');
  });

  it('classifies view libraries as frontend', () => {
    expect(classifyDeps({ react: '18' })).toMatchObject({ serverType: 'frontend', frameworkId: 'react' });
    expect(classifyDeps({ vue: '3' }).serverType).toBe('frontend');
    expect(classifyDeps({ vite: '5' }).serverType).toBe('frontend');
  });

  it('classifies server frameworks as backend', () => {
    expect(classifyDeps({ express: '4' })).toMatchObject({ serverType: 'backend', frameworkId: 'express' });
    expect(classifyDeps({ fastify: '4' }).serverType).toBe('backend');
    expect(classifyDeps({ '@nestjs/core': '10' }).frameworkId).toBe('nest');
  });

  it('prefers the meta-framework when a view lib is also present (order wins)', () => {
    // Next apps also depend on react; the fullstack row must win.
    expect(classifyDeps({ react: '18', next: '14' }).serverType).toBe('fullstack');
  });

  it('infers non-JS runtimes from the command → backend', () => {
    expect(classifyDeps({}, 'python -m uvicorn app:main')).toMatchObject({
      serverType: 'backend',
      frameworkId: 'python',
    });
    expect(classifyDeps({}, '/usr/bin/ruby bin/rails s').frameworkId).toBe('ruby');
  });

  it('falls back to backend/node for an unrecognised JS project', () => {
    expect(classifyDeps({ 'some-lib': '1' }).serverType).toBe('backend');
    expect(classifyDeps({ 'some-lib': '1' }).frameworkId).toBe('node');
  });

  it('returns a bare backend when nothing is known', () => {
    expect(classifyDeps({})).toEqual({ serverType: 'backend' });
  });
});

describe('isTechnicalName', () => {
  it('flags structural folder tokens', () => {
    for (const n of ['src', 'backend', 'frontend', 'server', 'client', 'app', 'api', 'dist'])
      expect(isTechnicalName(n)).toBe(true);
    expect(isTechnicalName('SRC')).toBe(true); // case-insensitive
  });

  it('accepts real project names', () => {
    for (const n of ['gopher', 'volero', 'outreach']) expect(isTechnicalName(n)).toBe(false);
  });
});
