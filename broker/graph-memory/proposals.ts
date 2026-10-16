import { entityTypes } from "./contracts.ts";
import type { ExtractionRun } from "./adapters/contracts.ts";

type Row = Record<string, any>;
/**
 * The canonical claims and witnesses for one extraction run's proposals, as the memory worker
 * submits them. Throws when a proposal names an entity it did not declare or quotes another record.
 */
export function extractionProposals(result: ExtractionRun, observationId: string) {
  const entities = new Map(
    result.proposals.entities.map((e) => [e.temporaryRef, e]),
  );
  const proposals: Row[] = [];
  for (const a of result.proposals.assertions) {
    const s = entities.get(a.subjectRef),
      o =
        "entityRef" in a.object
          ? entities.get(a.object.entityRef)
          : undefined;
    if (!s || !s.aliases[0] || ("entityRef" in a.object && !o)) throw new Error('Unresolved extraction entity');
    const quote = a.quotes[0];
    if (!quote || quote.sourceRecordId !== observationId) throw new Error('Unsupported extraction quote');
    // An uncertain or unparseable interpretation never becomes an exact boundary.
    const parsed =
      !a.temporal.uncertain &&
      a.temporal.interpretation &&
      /^\d{4}-\d\d-\d\dT/.test(a.temporal.interpretation)
        ? Date.parse(a.temporal.interpretation) * 1000
        : NaN;
    const temporal = Number.isSafeInteger(parsed) ? parsed : null;
    const uncertain = a.temporal.uncertain || (!!a.temporal.interpretation && temporal === null);
    // A statement that names no time is undated, not approximately dated: its validity stays
    // unknown and no date is invented. Only a time that was stated but not resolved is approximate;
    // its words, or without them the model's reading, are kept so it stays reviewable.
    const stated = Array.from(a.temporal.expression?.trim() || (temporal === null ? a.temporal.interpretation?.trim() : "") || "").slice(0, 500).join("");
    const claim = {
      subject: { type: entityTypes.find(type=>type.toUpperCase()===s.kind), name: s.aliases[0] },
      predicate: a.predicate,
      ...(o
        ? { object: { type: entityTypes.find(type=>type.toUpperCase()===o.kind), name: o.aliases[0] } }
        : { value: "literal" in a.object ? a.object.literal : null }),
      qualifiers: a.qualifiers,
      polarity: a.polarity,
      modality: a.modality,
      epistemic_type: a.epistemicType,
      valid_mode:
        temporal !== null
          ? "bounded"
          : uncertain
            ? "unknown"
            : "known_current",
      valid_from_us: temporal,
      valid_to_us: null,
      time_precision: temporal !== null ? "instant" : uncertain && stated ? "approximate" : "unknown",
      time_expression: stated,
      extraction_confidence: 1,
    };
    // Unresolved natural-language corrections remain reviewable candidates; resolved inspector APIs apply intervals.
    if (a.operation === "changes" || a.operation === "corrects")
      claim.modality = "reported";
    proposals.push({
        claim,
        witness: {
          observation_id: observationId,
          quote: quote.quote,
          occurrence: quote.occurrenceIndex,
        },
      });
  }
  return proposals;
}
