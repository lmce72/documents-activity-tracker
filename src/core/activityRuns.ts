/** Continuous highlighted activity, independent of target, channel and hour boundaries. */
export function activityRuns<S extends { startMinute: number; durationMinutes: number }>(
  rows: readonly { hour: number; segments: readonly S[] }[],
): Map<S, { id: string; start: number; end: number }> {
  const result = new Map<S, { id: string; start: number; end: number }>();
  const pieces = rows.flatMap(row => row.segments.map(segment => ({
    segment, start: row.hour * 60 + segment.startMinute,
    end: row.hour * 60 + segment.startMinute + segment.durationMinutes,
  }))).sort((a, b) => a.start - b.start);
  let run: { id: string; start: number; end: number } | undefined;
  for (const piece of pieces) {
    // Only floating point noise is tolerated; an actual unrecorded gap stays a gap.
    if (!run || piece.start > run.end + 1e-6) {
      run = { id: String(piece.start), start: piece.start, end: piece.end };
    } else run.end = Math.max(run.end, piece.end);
    result.set(piece.segment, run);
  }
  return result;
}
