import { config } from "../config.js";

/**
 * The two unit conversions the HyperFrames backend depends on.
 *
 * kernelshorts plans in FRAMES and speaks audio in dB, because that is what an
 * NLE and ffmpeg speak. A HyperFrames composition times in SECONDS and takes
 * LINEAR gain in `data-volume`. Getting either wrong is silent: a frame number
 * written into `data-start` renders a 64-second clip, and a dB value written
 * into `data-volume` is clamped to a boost.
 */

const { fps } = config.video;

/**
 * Rounded to microseconds so the emitted HTML stays readable and diffable.
 * At 30fps one microsecond is 3e-5 of a frame, far below anything the renderer
 * can resolve, so this is lossless in practice.
 */
export function framesToSeconds(frames: number): number {
  return Math.round((frames / fps) * 1e6) / 1e6;
}

/**
 * Rounds a value that is ALREADY in seconds to the same microsecond grid.
 *
 * `framesToSeconds` covers conversions, but seconds-space arithmetic (summing
 * a word window onto a beat offset, subtracting a trim) reintroduces binary
 * float noise — `3.0000000000000004` reaching a `data-duration` is the visible
 * symptom. Every second-valued number written into the HTML goes through this
 * or `framesToSeconds`, so the emitted attributes stay readable and diffable.
 */
export function roundSeconds(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6;
}

/** dB to linear amplitude. 0 dB is unity, -20 dB is a tenth, -60 dB is silence. */
export function dbToGain(db: number): number {
  return Math.round(10 ** (db / 20) * 1e6) / 1e6;
}
