import { csvCell } from './csv';

describe('csvCell', () => {
  it('neutralizes text a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil","click")')).toBe(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });
  it('leaves ordinary text and numbers alone', () => {
    expect(csvCell('Smith Campaign')).toBe('Smith Campaign');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell(null)).toBe('');
  });
});
