function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertCounts(...values: number[]): void {
  if (!values.every(validCount)) throw new RangeError();
}

function roundedRatio(numerator: number, denominator: number, multiplier: bigint, scale: bigint): number {
  const scaled = BigInt(numerator) * multiplier;
  const divisor = BigInt(denominator);
  let rounded = scaled / divisor;
  if ((scaled % divisor) * 2n >= divisor) rounded += 1n;
  return Number(rounded) / Number(scale);
}

export function ppgOf(points: number, played: number): number | null {
  assertCounts(points, played);
  return played === 0 ? null : roundedRatio(points, played, 100n, 100n);
}

export function winPctOf(won: number, played: number): number | null {
  assertCounts(won, played);
  return played === 0 ? null : roundedRatio(won, played, 1_000n, 10n);
}
