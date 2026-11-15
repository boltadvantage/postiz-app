import { alertMatcher, cleanWords } from './alert-words';

describe('alert words', () => {
  it('keeps plain words, lowercased, without repeats', () => {
    expect(cleanWords('Fuck, idiot  fuck,a, f-word')).toEqual(['fuck', 'fword', 'idiot']);
    expect(cleanWords(['Idiot', 42, null])).toEqual(['42', 'idiot']);
    expect(cleanWords(undefined)).toEqual([]);
  });

  it('sees through the usual disguises', () => {
    const hit = alertMatcher(['fuck', 'dumbass']);
    expect(hit('What the fuck')).toEqual(['fuck']);
    expect(hit('Why the f**k MAGA dumba**es')).toEqual(['fuck', 'dumbass']);
    expect(hit('F*CKING clown')).toEqual(['fuck']);
    expect(hit('f.u.c.k off')).toEqual(['fuck']);
    expect(hit('f-ck')).toEqual(['fuck']);
  });

  it('leaves ordinary words alone', () => {
    const hit = alertMatcher(['fuck', 'ass']);
    expect(hit('Thanks for the update, great class!')).toEqual([]);
    expect(hit('if u can keep it')).toEqual([]);
    expect(hit('')).toEqual([]);
    expect(alertMatcher([])('fuck')).toEqual([]);
  });
});
