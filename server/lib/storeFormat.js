// The shape of a saved filing file, and how it is turned back into the
// parsed result (shared with the browser build, which reads the same files).

import { pickPrimary } from './statementTypes.js';

const STD = /^(us-gaap|ifrs-full|dei|srt):/;

// what goes into a filing file: no `statements` (rebuilt from allStatements),
// standard concepts' documentation moved to the shared dictionary
export function slim(result, docs, onNewDoc = () => {}) {
  const { statements, ...rest } = result;
  rest.allStatements = (rest.allStatements || []).map((st) => ({
    ...st,
    lineItems: (st.lineItems || []).map((li) => {
      if (!li.documentation || !STD.test(li.concept)) return li;
      if (docs[li.concept] !== li.documentation) {
        docs[li.concept] = li.documentation;
        onNewDoc();
      }
      const { documentation, ...x } = li;
      return x;
    }),
  }));
  return rest;
}
export function fatten(result, docs) {
  for (const st of result.allStatements || []) {
    for (const li of st.lineItems || []) if (!li.documentation && STD.test(li.concept) && docs[li.concept]) li.documentation = docs[li.concept];
  }
  if (!result.statements) result.statements = pickPrimary(result.allStatements || []);
  return result;
}

