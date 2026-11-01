// Bolt Advantage: one safe CSV cell. Text starting with = + - @ (or a tab or
// carriage return) is prefixed with ' so a spreadsheet shows it instead of
// running it as a formula; numbers are left alone.
export const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
