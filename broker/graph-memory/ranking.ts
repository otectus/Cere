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
export function ftsQuery(text: string) {
  return (text.match(/[\p{L}\p{N}_]+/gu) || [])
    .slice(0, 32)
    .map((s) => '"' + s.replaceAll('"', '""') + '"')
    .join(" OR ");
}
export const estimateTokens = (text: string) =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 3) + 12;
