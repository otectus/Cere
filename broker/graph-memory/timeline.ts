/**
 * A fact's history as a source-linked timeline (M05): every version of one assertion slot in the
 * order Cere learned them, with its valid-time interval, the revision interval during which it was
 * the known view, its status, and the evidence that supports it. Each entry names the fields that
 * changed from the version before it. Built from inspect()'s history; it reads nothing else, never
 * merges valid time with recording time, and labels nothing as proven: status is the engine's own.
 */
type Row = Record<string, any>;

const watched = ['predicate', 'object_entity_id', 'value_json', 'qualifiers', 'polarity', 'modality', 'status', 'valid_mode', 'valid_from_us', 'valid_to_us'] as const;
const labels: Record<string, string> = {
  predicate: 'relationship', object_entity_id: 'object', value_json: 'value', qualifiers: 'qualifiers', polarity: 'polarity',
  modality: 'modality', status: 'status', valid_mode: 'validity', valid_from_us: 'valid from', valid_to_us: 'valid until',
};
const iso = (us: unknown) => typeof us === 'number' && Number.isFinite(us) ? new Date(Math.floor(us / 1000)).toISOString() : null;

export function factTimeline(history: Row[], pinned = false) {
  const versions = [...history].sort((a, b) => a.known_from_revision - b.known_from_revision || String(a.version_id).localeCompare(String(b.version_id)));
  return {
    pinned,
    entries: versions.map((version, index) => {
      const previous = index ? versions[index - 1] : undefined;
      return {
        version_id: version.version_id, logical_id: version.logical_id, claim: version.claim,
        status: version.status, modality: version.modality, polarity: version.polarity,
        valid: { mode: version.valid_mode, from: iso(version.valid_from_us), to: iso(version.valid_to_us) },
        known: { from_revision: version.known_from_revision, to_revision: version.known_to_revision ?? null, from: iso(version.known_from_us), to: iso(version.known_to_us) },
        current: version.known_to_revision === null || version.known_to_revision === undefined,
        changed: previous ? watched.filter(field => String(previous[field] ?? '') !== String(version[field] ?? '')).map(field => labels[field]) : [],
        evidence: (version.evidence || []).slice(0, 8).map((item: Row) => ({ id: item.id, observation_id: item.observation_id, trust: item.trust, witness: String(item.witness || '').slice(0, 300) })),
      };
    }),
  };
}
