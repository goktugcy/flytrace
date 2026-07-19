import type { Position } from '../domain/position.ts';

export function withSourceMetadata(
  positions: Position[],
  source: string,
  receivedAtMs: number,
): Position[] {
  const receivedAt = new Date(receivedAtMs).toISOString();
  return positions.map((p) => {
    const sourceTimestamp = p.sourceTimestamp ?? p.ts;
    const sourceMs = Date.parse(sourceTimestamp);
    const ageMs = Number.isFinite(sourceMs) ? Math.max(0, receivedAtMs - sourceMs) : undefined;
    return {
      ...p,
      source,
      sourceTimestamp,
      receivedAt,
      ...(ageMs !== undefined ? { ageMs } : {}),
    };
  });
}
