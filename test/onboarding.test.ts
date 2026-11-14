import { describe, expect, it } from 'vitest';
import { guessRole } from '../src/renderer/src/components/Onboarding.js';

describe('onboarding repo guess', () => {
  it('guesses roles from repo names and leaves anything unclear unchosen', () => {
    expect(guessRole('pm-crm')).toBe('crm');
    expect(guessRole('customer-notes')).toBe('crm');
    expect(guessRole('pm-pdr')).toBe('pdr');
    expect(guessRole('product-decisions')).toBe('pdr');
    expect(guessRole('pm-artifacts')).toBe('artifacts');
    expect(guessRole('claude-skills')).toBe('artifacts');
    expect(guessRole('website')).toBeUndefined();
    expect(guessRole('microcrmx')).toBeUndefined();
  });
});
