import { describe, expect, it } from 'vitest';
import { fileToLink, keyOf, linkable, pullToLink, sectionToLink, setType, toggle, type Selection } from '../src/renderer/src/viewmodel/picker.js';

describe('link picker selection', () => {
  it('turns a ticked file into the right kind of link for its repo', () => {
    expect(fileToLink('artifacts', { path: 'control-book/checkout.md', sha: 'a'.repeat(40) })).toMatchObject({ kind: 'artifact', artifactType: 'control-book', title: 'checkout' });
    expect(fileToLink('crm', { path: 'customers/acme-corp.md', sha: '' })).toEqual({ role: 'crm', kind: 'customer', path: 'customers/acme-corp.md', title: 'acme-corp', blobSha: undefined });
    expect(fileToLink('pdr', { path: 'specs/spec-003.md', sha: '' })).toMatchObject({ kind: 'decision' });
    expect(sectionToLink('customers/acme.md', '', { heading: 'Call', anchor: 'call', body: '' })).toMatchObject({ kind: 'conversation', anchor: 'call', title: 'Call' });
    expect(pullToLink({ number: 7, title: 'Spec', state: 'open', merged: false, draft: false, author: '', updatedAt: '' })).toMatchObject({ kind: 'decision', prNumber: 7, title: '#7 Spec' });
  });

  it('toggles, retypes, and leaves out items already on the product', () => {
    const a = fileToLink('artifacts', { path: 'a.md', sha: '' });
    const b = fileToLink('crm', { path: 'c.md', sha: '' });
    let s: Selection = new Map();
    s = toggle(toggle(s, a), b);
    expect(s.size).toBe(2);
    s = setType(s, keyOf(a), 'problem-brief');
    expect(s.get(keyOf(a))?.artifactType).toBe('problem-brief');
    expect(setType(s, keyOf(b), 'problem-brief')).toBe(s); // only artifacts have a type
    expect(linkable(s, new Set([keyOf(b)])).map((l) => l.path)).toEqual(['a.md']);
    expect(toggle(s, a).size).toBe(1);
  });
});
