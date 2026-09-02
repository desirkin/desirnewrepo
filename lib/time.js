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
