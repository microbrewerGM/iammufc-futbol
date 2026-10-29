type ReadMetadata = { duration?: unknown; rows_read?: unknown };

/** Emit only aggregate D1 timing metadata. Sink failures never affect reads. */
export function recordReadTiming(query: string, meta: ReadMetadata | null | undefined): void {
  const event = {
    query,
    duration: typeof meta?.duration === "number" ? meta.duration : null,
    rows_read: typeof meta?.rows_read === "number" ? meta.rows_read : null,
  };
  try {
    console.log(event);
  } catch {
    // Observability must never change the response path.
  }
}
