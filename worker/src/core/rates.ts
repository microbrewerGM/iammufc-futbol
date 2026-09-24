/** A displayed rate must never manufacture a zero from missing or invalid data. */
export function per90(total: number | null, minutes: number | null): number | null {
  if (
    !Number.isSafeInteger(total) ||
    total === null ||
    total < 0 ||
    !Number.isSafeInteger(minutes) ||
    minutes === null ||
    minutes <= 0
  ) {
    return null;
  }
  return (90 * total) / minutes;
}
