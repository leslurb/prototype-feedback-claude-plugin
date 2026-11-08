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
  const repoUrls = [...new Set([typeof json.repo === 'string' ? json.repo : null,
    ...Object.values(json.repo_hints || {}).map((h) => h && h.repo)].filter(Boolean))];
  const exportKind = typeof json.export_kind === 'string' ? json.export_kind : null;
  // Handoff v2 §2: a full export is `delta: false` or any export_kind other than send_claude_code.
  // A 0.7.0 send has delta: true and no export_kind; no delta flag at all (v5, manual exports) counts as full.
  const fullExport = json.delta !== true || (exportKind !== null && exportKind !== 'send_claude_code');
  return { version, exportId: json.export_id || null, exportedAt: json.exported_at || null,
           reviewer: json.reviewer || null, repoUrls, exportKind, fullExport, comments, raw: json };
}
