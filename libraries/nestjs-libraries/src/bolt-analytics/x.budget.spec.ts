import { X_DAILY_READS, X_HISTORY_READS, X_INBOX_READS } from './x.analytics';

describe('X read budget split', () => {
  const env = { ...process.env };
  afterEach(() => (process.env = { ...env }));

  it('defaults to 200 a day: 150 for History, 50 kept for the inbox', () => {
    delete process.env.BOLT_X_DAILY_READS;
    delete process.env.BOLT_X_INBOX_READS;
    expect([X_DAILY_READS(), X_HISTORY_READS(), X_INBOX_READS()]).toEqual([200, 150, 50]);
  });

  it('never lets the inbox share exceed the whole cap', () => {
    process.env.BOLT_X_DAILY_READS = '30';
    expect([X_INBOX_READS(), X_HISTORY_READS()]).toEqual([30, 0]);
  });

  it('can be tuned', () => {
    process.env.BOLT_X_DAILY_READS = '400';
    process.env.BOLT_X_INBOX_READS = '100';
    expect([X_HISTORY_READS(), X_INBOX_READS()]).toEqual([300, 100]);
  });
});
