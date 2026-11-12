// Works out which reminder slot (if any) is due, in the user's own time zone.

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export const GRACE_MINUTES = 2; // a slot noticed later than this is skipped, not sent late

export const DEFAULT_SETTINGS = {
  interval: 10,
  timezone: 'UTC',
  windows: [{ start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }],
};

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

export function localParts(now, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
    day: WEEKDAY[p.weekday],
  };
}

/** Clean up settings sent by the app so the scheduler can trust them. */
export function sanitizeSettings(input) {
  const interval = Math.min(240, Math.max(1, Math.round(Number(input?.interval) || 10)));
  const windows = (Array.isArray(input?.windows) ? input.windows : [])
    .slice(0, 20)
    .map((w) => ({
      start: String(w?.start ?? ''),
      end: String(w?.end ?? ''),
      days: [...new Set((Array.isArray(w?.days) ? w.days : []).map(Number).filter((d) => d >= 0 && d <= 6))].sort(),
    }))
    .filter((w) => toMin(w.start) !== null && toMin(w.end) !== null);
  return { interval, timezone: validTimeZone(String(input?.timezone || 'UTC')), windows };
}

/**
 * The most recent slot at or before `now`, if `now` is inside a time frame.
 * Slots run from each time frame's start: 09:00, 09:10, … up to its end.
 * Returns { key, at, late } or null. `late` is minutes since the slot.
 */
export function currentSlot(settings, now) {
  const { date, minutes, day } = localParts(now, validTimeZone(settings.timezone));
  let best = null;
  for (const w of settings.windows) {
    const s = toMin(w.start), e = toMin(w.end);
    if (s === null || e === null || !w.days.includes(day) || minutes < s || minutes > e) continue;
    const slot = s + Math.floor((minutes - s) / settings.interval) * settings.interval;
    if (best === null || slot > best) best = slot;
  }
  if (best === null) return null;
  const late = minutes - best;
  const hh = String(Math.floor(best / 60)).padStart(2, '0');
  const mm = String(best % 60).padStart(2, '0');
  return {
    key: `${date}T${hh}:${mm}`,
    at: new Date(Math.floor(now.getTime() / 60000) * 60000 - late * 60000),
    late,
  };
}
