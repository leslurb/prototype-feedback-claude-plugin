const INTENT_TO_VERB = { bug: 'fix', polish: 'change', 'behavior-change': 'change', question: 'ask' };
const VERBS = new Set(['fix', 'change', 'ask', 'idea']);

/** Normalise a prototype-feedback/v5 or v6 export to one shape the skill and status code use. */
export function normalizeExport(json) {
  const m = /^prototype-feedback\/v(\d+)$/.exec(json?.schema || '');
  if (!m || !Array.isArray(json.comments)) throw new Error(`not a prototype-feedback export (schema ${json?.schema})`);
  const version = Number(m[1]);
  const comments = json.comments.map((c) => ({
    ...c,
    verb: VERBS.has(c.verb) ? c.verb : (INTENT_TO_VERB[c.intent] || 'fix'),
    urgent: typeof c.urgent === 'boolean' ? c.urgent : c.severity === 'high',
  }));
  const repoUrls = [...new Set(Object.values(json.repo_hints || {}).map((h) => h && h.repo).filter(Boolean))];
  return { version, exportId: json.export_id || null, exportedAt: json.exported_at || null,
           reviewer: json.reviewer || null, repoUrls, comments, raw: json };
}
