/**
 * When a reel goes live. Pure functions, no I/O — the scheduler and the tests
 * share them.
 *
 * A "slot" is a wall-clock time in a named time zone ("19:30" Asia/Kolkata).
 * Each platform gets at most one reel per local day, so a backlog spreads out
 * over successive evenings instead of three reels landing at once.
 */

export interface SlotRule {
  /** "HH:MM", 24-hour, in `timezone`. */
  time: string;
  timezone: string;
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant, as seen in `tz`. */
export function localParts(at: Date, tz: string): LocalParts {
  const p = Object.fromEntries(
    formatter(tz).formatToParts(at).map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number | undefined>;
  const get = (k: string) => p[k] ?? NaN;
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Minutes the zone is ahead of UTC at that instant (IST → 330). */
function offsetMinutes(utcMs: number, tz: string): number {
  const p = localParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

/** The instant at which the clock in `tz` reads the given wall time. */
export function zonedToUtc(p: LocalParts, tz: string): Date {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  let t = guess - offsetMinutes(guess, tz) * 60_000;
  // Second pass settles a DST boundary between the guess and the answer.
  t = guess - offsetMinutes(t, tz) * 60_000;
  return new Date(t);
}

function parseHHMM(time: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(`Slot time must be "HH:MM" (24h), got "${time}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** "YYYY-MM-DDTHH:MM" read as wall-clock time in `tz` (for `--at`). */
export function parseLocalDateTime(s: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Expected "YYYY-MM-DDTHH:MM" (${tz} time), got "${s}"`);
  const n = (i: number) => Number(m[i]);
  return zonedToUtc({ year: n(1), month: n(2), day: n(3), hour: n(4), minute: n(5) }, tz);
}

function dayKey(at: Date, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * The next free slot: the earliest day whose slot is at least `leadMinutes`
 * from now and on which this platform has nothing else scheduled.
 */
export function nextSlot(
  now: Date,
  rule: SlotRule,
  taken: Date[] = [],
  leadMinutes = 20,
): Date {
  const { hour, minute } = parseHHMM(rule.time);
  const busy = new Set(taken.map((t) => dayKey(t, rule.timezone)));
  const today = localParts(now, rule.timezone);
  const earliest = now.getTime() + leadMinutes * 60_000;
  for (let i = 0; i < 400; i++) {
    // Date.UTC normalises day overflow (Nov 31 → Dec 1); only the calendar
    // date is taken from it, the wall time is applied in the zone.
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const candidate = zonedToUtc(
      { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute },
      rule.timezone,
    );
    if (candidate.getTime() < earliest) continue;
    if (busy.has(dayKey(candidate, rule.timezone))) continue;
    return candidate;
  }
  throw new Error("No free slot in the next 400 days");
}

export type DueDecision = "wait" | "publish" | "late";

/**
 * What to do with a post whose slot is `slot`:
 *  - wait     the slot hasn't arrived
 *  - publish  it has, and we're within `maxLateHours` of it
 *  - late     the Mac was asleep/offline through the slot by more than
 *             `maxLateHours` — posting at 3 am wastes the reel, so the caller
 *             moves it to the next slot instead.
 */
export function decideDue(slot: Date, now: Date, maxLateHours: number): DueDecision {
  const late = now.getTime() - slot.getTime();
  if (late < 0) return "wait";
  return late > maxLateHours * 3_600_000 ? "late" : "publish";
}

/** "Sat 8 Nov, 7:30 pm IST"-style label for logs and notifications. */
export function describeSlot(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}
