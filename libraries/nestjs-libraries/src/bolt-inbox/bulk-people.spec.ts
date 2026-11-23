import { personChange } from './people';

describe('bulk people changes', () => {
  const person = { tags: JSON.stringify(['donor', 'press']), note: 'Met at the fair' };

  it('adds and removes tags without touching the others', () => {
    expect(JSON.parse(personChange(person, { addTags: ['Troll', 'donor'], removeTags: ['press'] }).tags!)).toEqual(['donor', 'troll']);
  });

  it('adds a note as a new line, or replaces it', () => {
    expect(personChange(person, { note: 'Blocked on FB' }).note).toBe('Met at the fair\nBlocked on FB');
    expect(personChange({ tags: null, note: null }, { note: 'First' }).note).toBe('First');
    expect(personChange(person, { note: 'Fresh', noteMode: 'replace' }).note).toBe('Fresh');
    expect(personChange(person, { note: '', noteMode: 'replace' }).note).toBeNull();
  });

  it('mutes or unmutes, and leaves out what was not asked for', () => {
    expect(personChange(person, { muted: true })).toEqual({ muted: true });
    expect(personChange(person, { muted: false })).toEqual({ muted: false });
    expect(personChange(person, {})).toEqual({});
    expect(personChange(person, { note: '   ' })).toEqual({});
  });
});
