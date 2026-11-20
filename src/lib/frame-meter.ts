/** Counts only intervals between this renderer's successful submissions.
 * Browser RAF cadence can be refresh-limited; this is not GPU throughput.
 */
export class FrameMeter {
  previous: number | null = null;
  intervals = 0;
  elapsedMs = 0;
  submitMs = 0;

  record(now: number, submissionMs: number) {
    if (this.previous !== null && now > this.previous) {
      this.intervals++;
      this.elapsedMs += now - this.previous;
      this.submitMs += submissionMs;
    }
    this.previous = now;
  }
  read() {
    if (!this.intervals || this.elapsedMs <= 0) return null;
    return {
      fps: this.intervals * 1000 / this.elapsedMs,
      frameMs: this.elapsedMs / this.intervals,
      submitMs: this.submitMs / this.intervals,
    };
  }
  reset() { this.previous = null; this.clearWindow(); }
  clearWindow() { this.intervals = 0; this.elapsedMs = 0; this.submitMs = 0; }
}
