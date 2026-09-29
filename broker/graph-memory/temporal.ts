export type Interval = {
  valid_from_us: number | null;
  valid_to_us: number | null;
  valid_mode: string;
};
export function overlaps(a: Interval, b: Interval) {
  if (a.valid_mode !== "bounded" || b.valid_mode !== "bounded") return true;
  return (
    (a.valid_from_us ?? -Infinity) < (b.valid_to_us ?? Infinity) &&
    (b.valid_from_us ?? -Infinity) < (a.valid_to_us ?? Infinity)
  );
}
/** Pure half-open subtraction. Uncertain dates never manufacture historical bounds. */
export function remainder(old: Interval, change: Interval): Interval[] {
  if (!overlaps(old, change)) return [old];
  if (old.valid_mode !== "bounded" || change.valid_mode !== "bounded")
    return [];
  const parts: Interval[] = [];
  if (old.valid_from_us! < change.valid_from_us!)
    parts.push({ ...old, valid_to_us: change.valid_from_us });
  if (
    change.valid_to_us !== null &&
    (old.valid_to_us === null || change.valid_to_us < old.valid_to_us)
  )
    parts.push({ ...old, valid_from_us: change.valid_to_us });
  return parts;
}
export function eligibleTime(v: Interval, world?: number) {
  if (world === undefined)
    return (
      v.valid_mode === "atemporal" ||
      v.valid_mode === "known_current" ||
      v.valid_mode === "unknown" ||
      (v.valid_from_us !== null &&
        v.valid_from_us <= Date.now() * 1000 &&
        (v.valid_to_us === null || Date.now() * 1000 < v.valid_to_us))
    );
  if (v.valid_mode === "atemporal") return true;
  return (
    v.valid_mode === "bounded" &&
    v.valid_from_us !== null &&
    v.valid_from_us <= world &&
    (v.valid_to_us === null || world < v.valid_to_us)
  );
}
