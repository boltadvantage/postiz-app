import { alertMatcher, alertRanges, cleanWords } from './alert-words';

describe('alert words', () => {
  it('keeps plain words, lowercased, without repeats', () => {
    expect(cleanWords('Fuck, idiot  fuck,a, fword')).toEqual(['fuck', 'fword', 'idiot']);
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

  it('matches a quoted word only on its own', () => {
    expect(cleanWords('"ass", \u201chell\u201d, f**k, sh!t, idiot!')).toEqual(['"ass"', '"hell"', 'idiot']);
    const hit = alertMatcher(cleanWords('"ass", "hell"'));
    expect(hit('kiss my ass')).toEqual(['"ass"']);
    expect(hit('what an a$$!')).toEqual(['"ass"']);
    expect(hit('Go to hell.')).toEqual(['"hell"']);
    expect(hit('Hello, can you assist? Asses')).toEqual([]);
  });
});

describe('alert highlights', () => {
  it('marks each hit to the end of its word', () => {
    const text = 'Why the f**king MAGA dumba**es, go to hell';
    const marks = alertRanges(['fuck', 'dumbass', '"hell"'], text).map(([a, b]) => text.slice(a, b));
    expect(marks).toEqual(['f**king', 'dumba**es', 'hell']);
  });
});
