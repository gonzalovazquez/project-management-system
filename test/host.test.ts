import { describe, expect, it } from 'vitest';
import { apiBaseUrl, apiHostname, normalizeHost } from '../src/main/github/host.js';

describe('normalizeHost', () => {
  it('trims, lowercases and strips a scheme and trailing slashes', () => {
    expect(normalizeHost('GitHub.com')).toBe('github.com');
    expect(normalizeHost('https://github.example.com/')).toBe('github.example.com');
    expect(normalizeHost('  http://Git.Corp.Net//  ')).toBe('git.corp.net');
  });
  it('rejects empty input', () => {
    expect(() => normalizeHost('')).toThrow(/enter a github host/i);
    expect(() => normalizeHost('   ')).toThrow();
  });
  it('rejects a path or embedded whitespace', () => {
    expect(() => normalizeHost('github.com/some/org')).toThrow(/just the domain/i);
    expect(() => normalizeHost('git corp net')).toThrow(/just the domain/i);
  });
});

describe('apiBaseUrl / apiHostname', () => {
  it('routes github.com to api.github.com', () => {
    expect(apiBaseUrl('github.com')).toBe('https://api.github.com');
    expect(apiBaseUrl('GitHub.com')).toBe('https://api.github.com');
    expect(apiHostname('github.com')).toBe('api.github.com');
  });
  it('routes any other host to its own /api/v3', () => {
    expect(apiBaseUrl('git.example.com')).toBe('https://git.example.com/api/v3');
    expect(apiHostname('git.example.com')).toBe('git.example.com');
  });
  it('rejects an invalid host the same way normalizeHost does', () => {
    expect(() => apiBaseUrl('')).toThrow();
  });
});
