// Statement classification with no I/O (shared with the browser build):
// which of a filing's statements are the four primary ones, by title.

const STATEMENT_TYPES = [
  ['cash_flow', /CASH\s*FLOW/i],
  // banks say "Statements of Condition", funds "Statements of Assets and Liabilities"
  ['balance_sheet', /BALANCE\s*SHEET|FINANCIAL\s*(POSITION|CONDITION)|STATEMENTS?\s+OF\s+CONDITION|ASSETS\s+AND\s+LIABILITIES/i],
  ['comprehensive_income', /COMPREHENSIVE\s*(INCOME|LOSS|EARNINGS)/i],
  ['income_statement', /INCOME|OPERATIONS|EARNINGS|PROFIT|LOSS/i],
  ['equity', /EQUITY|DEFICIT|SHAREHOLDERS|STOCKHOLDERS|CAPITAL/i],
];
export const PRIMARY = ['balance_sheet', 'income_statement', 'cash_flow', 'equity'];

export function classify(title) {
  for (const [kind, re] of STATEMENT_TYPES) if (re.test(title)) return kind;
  return 'other';
}


// The four primary statements out of every statement in the filing.
export function pickPrimary(all) {
  const primary = Object.fromEntries(PRIMARY.map((k) => [k, null]));
  for (const st of all) if (st.type in primary && !primary[st.type] && !st.parenthetical) primary[st.type] = st;
  // IFRS filers often present a single combined statement of profit or loss
  // and other comprehensive income.
  if (!primary.income_statement) {
    primary.income_statement = all.find((st) => st.type === 'comprehensive_income' && !st.parenthetical) || null;
  }
  return primary;
}

// Saved results were classified by the rules of their day: re-run the title
// classifier so a newly recognised title (e.g. a bank's "Statements of
// Condition") gets its slot without re-downloading the filing.
export function reclassify(result) {
  let changed = false;
  for (const st of result.allStatements || []) {
    const t = classify(st.title);
    if (t !== st.type) {
      st.type = t;
      changed = true;
    }
  }
  if (changed || Object.values(result.statements || {}).some((v) => !v)) result.statements = pickPrimary(result.allStatements || []);
  return result;
}
