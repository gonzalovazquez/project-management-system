import { describe, expect, it } from 'vitest';
import { isTrustedUrl } from '../src/main/app/trust.js';

const indexFileUrl = 'file:///app/out/renderer/index.html';

describe('isTrustedUrl', () => {
  it('trusts the packaged index file, with or without a hash or query', () => {
    expect(isTrustedUrl(indexFileUrl, { indexFileUrl })).toBe(true);
    expect(isTrustedUrl(`${indexFileUrl}#/settings`, { indexFileUrl })).toBe(true);
    expect(isTrustedUrl(`${indexFileUrl}?x=1`, { indexFileUrl })).toBe(true);
  });

  it('rejects everything else when there is no dev server', () => {
    expect(isTrustedUrl('file:///app/out/renderer/other.html', { indexFileUrl })).toBe(false);
    expect(isTrustedUrl('https://evil.example.com', { indexFileUrl })).toBe(false);
    expect(isTrustedUrl('', { indexFileUrl })).toBe(false);
  });

  it('trusts the dev server origin only when one is configured', () => {
    const devUrl = 'http://localhost:5173';
    expect(isTrustedUrl('http://localhost:5173/', { indexFileUrl, devUrl })).toBe(true);
    expect(isTrustedUrl('http://localhost:5173/src/main.tsx', { indexFileUrl, devUrl })).toBe(true);
    expect(isTrustedUrl('http://localhost:9999/', { indexFileUrl, devUrl })).toBe(false);
    expect(isTrustedUrl('http://localhost:5173/', { indexFileUrl })).toBe(false);
  });

  it('never throws on an unparseable URL', () => {
    expect(isTrustedUrl('not a url', { indexFileUrl, devUrl: 'http://localhost:5173' })).toBe(false);
  });
});
