// Session time anchored to ET. The trading "day" for locks and rollups is the
// calendar date in America/New_York, whatever the host clock is set to.
const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function nowIso() {
  return new Date().toISOString();
}

// ET calendar date "YYYY-MM-DD" for a given instant (default: now).
export function sessionDate(at = new Date()) {
  return ET_DATE.format(at);
}

const ET_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  hour12: false,
});

// ET hour-of-day (0-23) for a given instant.
export function etHour(at = new Date()) {
  return Number(ET_HOUR.format(at)) % 24;
}

// ET hour-bucket key "YYYY-MM-DDTHH" — the unit of all RUMINT baselines
// (session anchor is ET, so chatter windows are ET too).
export function etHourKey(at = new Date()) {
  return `${sessionDate(at)}T${String(etHour(at)).padStart(2, '0')}`;
}
