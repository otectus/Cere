export function rrf(lists: string[][], constant = 60) {
  const scores = new Map<string, number>();
  for (const list of lists)
    for (const [i, id] of [...new Set(list)].entries())
      scores.set(id, (scores.get(id) || 0) + 1 / (constant + i + 1));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
export function relationalRank(
  seeds: Map<string, number>,
  edges: { from: string; to: string; weight: number }[],
  alpha = 0.85,
) {
  const ids = [
    ...new Set([...seeds.keys(), ...edges.flatMap((e) => [e.from, e.to])]),
  ];
  const sum = [...seeds.values()].reduce((a, b) => a + Math.max(0, b), 0);
  if (!sum) return new Map<string, number>();
  const s = new Map(
    ids.map((id) => [id, Math.max(0, seeds.get(id) || 0) / sum]),
  );
  let p = new Map(s);
  const outgoing = new Map<string, { to: string; weight: number }[]>();
  for (const e of edges) {
    if (e.weight <= 0 || !Number.isFinite(e.weight)) continue;
    const row = outgoing.get(e.from) || [];
    row.push(e);
    outgoing.set(e.from, row);
  }
  for (let iter = 0; iter < 30; iter++) {
    const next = new Map(ids.map((id) => [id, (1 - alpha) * s.get(id)!]));
    let dangling = 0;
    for (const id of ids) {
      const row = outgoing.get(id);
      if (!row?.length) {
        dangling += p.get(id)!;
        continue;
      }
      const total = row.reduce((a, e) => a + e.weight, 0);
      for (const e of row)
        next.set(
          e.to,
          next.get(e.to)! + (alpha * p.get(id)! * e.weight) / total,
        );
    }
    for (const id of ids)
      next.set(id, next.get(id)! + alpha * dangling * s.get(id)!);
    const delta = ids.reduce(
      (a, id) => a + Math.abs(next.get(id)! - p.get(id)!),
      0,
    );
    p = next;
    if (delta < 1e-6) break;
  }
  return p;
}
/**
 * English function words, contraction fragments, conversational acknowledgements, and the words
 * of workflow replies such as "Proceed with the next phase." They carry no topic: a passage that
 * shares only these with a query is not related to it.
 */
const stopwords = new Set(
  ("a about above after again against all also although am an and any anyway are as at be because been before " +
    "being below between both but by can could did do does doing done down during each either else even ever every " +
    "few for from further get gets getting got had has have having he her here hers herself him himself his how however " +
    "i if in instead into is it its itself just let lets me might more most much must my myself neither no nor not now " +
    "of off on once only or other our ours ourselves out over own perhaps quite rather same shall she should so some " +
    "such than that the their theirs them themselves then there these they this those though through to too under until " +
    "up upon us very was we were what whatever when where whether which while who whom whose why will with within " +
    "without would yet you your yours yourself yourselves " +
    "ll re ve im ive youre thats whats don dont doesn doesnt didn didnt isn isnt aren wasn weren won wont wouldn " +
    "shouldn couldn hasn haven hadn ain cant " +
    "ok okay yes yeah yep yup nope sure thanks thank thx please pls hi hello hey great good nice cool fine awesome " +
    "perfect alright right proceed continue go ahead sounds seems looks look think know want need really well maybe " +
    "probably actually basically still already something anything everything nothing thing things stuff lot lots bit " +
    "way kind try keep going guess mean say said tell told see like " +
    "next stage stages phase phases step steps full fully implementation implement approved approve start begin " +
    "finish complete completed first second third")
    .split(" "),
);
/** A query's distinct words, in order and case-insensitively: runs of letters, digits and underscores. */
function words(text: string) {
  const seen = new Set<string>();
  return (text.match(/[\p{L}\p{N}_]+/gu) || []).filter((word) => {
    const key = word.toLowerCase();
    return !seen.has(key) && !!seen.add(key);
  });
}
/** The words that can relate a passage to the query: neither a single character nor a stopword. */
export function informativeTerms(text: string) {
  return words(text).filter((word) => Array.from(word).length > 1 && !stopwords.has(word.toLowerCase()));
}
/** Whether a text has any informative term; stops at the first. */
export function hasInformativeTerm(text: string) {
  for (const [word] of text.matchAll(/[\p{L}\p{N}_]+/gu))
    if (Array.from(word).length > 1 && !stopwords.has(word.toLowerCase())) return true;
  return false;
}
/**
 * A bounded FTS5 expression of quoted terms. It searches the informative terms; without any,
 * an explicit search still matches its literal words, while automatic recall has nothing to find.
 */
export function ftsQuery(text: string, informativeOnly = false) {
  const informative = informativeTerms(text);
  return (informative.length || informativeOnly ? informative : words(text))
    .slice(0, 32)
    .map((s) => '"' + s.replaceAll('"', '""') + '"')
    .join(" OR ");
}
/** The inverse document frequency FTS5's bm25() gives a term found in n of N rows. */
export function bm25Idf(n: number, rows: number) {
  return Math.max(1e-6, Math.log((rows - n + 0.5) / (n + 0.5)));
}
/**
 * The weakest lexical match automatic recall accepts: about one term that occurs in 5% of all
 * passages, with slack for a longer passage. Matches on common words alone stay below it. Below
 * 50 passages document frequencies say little (a conversation repeats its own topic words), and
 * there are too few passages to flood a packet, so every match counts.
 */
export function lexicalFloor(rows: number) {
  return rows < 50 ? 0 : 0.85 * bm25Idf(Math.ceil(rows * 0.05), rows);
}
export const estimateTokens = (text: string) =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 3) + 12;
