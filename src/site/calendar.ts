import type { LifecycleRow } from '../types/lifecycle.ts';

/**
 * End-of-life dates, as a calendar anybody can subscribe to.
 *
 * The most useful thing this project can do with the lifecycle ledger, and the
 * cheapest. An EOL date is announced years in advance and then forgotten by
 * everyone it applies to — not because it is hard to find, but because nobody
 * goes looking for a date that is three years away.
 *
 * A calendar solves exactly that. Subscribed once, "Python 3.9 stops receiving
 * security fixes" arrives in the same place as next Tuesday's stand-up, months
 * before it matters, without anybody having to remember this site exists. Being
 * unnecessary to revisit is the point: the reading is delivered where the
 * decision gets made.
 *
 * Published as a static file like everything else here, so it costs nothing to
 * serve and can be checked against `/data/eol.json` by anybody who doubts it.
 */

/** Only what a calendar client needs. RFC 5545, folded and escaped. */
const PRODID = '-//Sighttrue//EOL calendar//EN';

/**
 * Text in an ICS field, escaped.
 *
 * Commas and semicolons are field separators in RFC 5545, so a product name
 * containing one silently truncates the entry in some clients and corrupts the
 * whole feed in others. Backslash first, or the escapes escape each other.
 */
function ics(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold to 75 octets, as the spec requires.
 *
 * Long lines are not a style question here: Google Calendar and Outlook both
 * reject or mangle a feed with over-long lines, and a description naming a
 * product and a cycle passes 75 characters easily.
 */
function fold(line: string): string {
  if (line.length <= 75) return line;

  const parts = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  if (rest.length > 0) parts.push(` ${rest}`);

  return parts.join('\r\n');
}

const compact = (iso: string): string => iso.replace(/-/g, '');

/**
 * A stable identifier per cycle.
 *
 * Calendar clients update an existing entry when the UID matches and create a
 * duplicate when it does not. Derived from product and cycle rather than from
 * anything time-based, so a date that moves — and they do move — edits the
 * entry the subscriber already has instead of leaving both in their calendar.
 */
const uid = (row: LifecycleRow): string =>
  `${row.product}-${row.cycle}`.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

export interface CalendarOptions {
  /** Written into the feed so a stale subscription is visible as a stale date. */
  now: string;
}

export function renderCalendar(rows: readonly LifecycleRow[], options: CalendarOptions): string {
  const stamp = `${compact(options.now.slice(0, 10))}T000000Z`;

  /**
   * Cycles that have already ended are left out.
   *
   * A calendar is a tool for what is coming. Nineteen years of expired Alpine
   * releases in somebody's calendar is not a record, it is noise that gets the
   * subscription deleted — and the history is still in the ledger and on the
   * page for anybody who wants it.
   */
  const upcoming = rows
    .filter((row) => !row.ended && /^\d{4}-\d{2}-\d{2}$/.test(String(row.eol ?? '')))
    .sort((a, b) => String(a.eol).localeCompare(String(b.eol)) || uid(a).localeCompare(uid(b)));

  const events = upcoming.flatMap((row) => {
    const date = compact(String(row.eol));
    const name = `${row.product} ${row.cycle}`;

    return [
      'BEGIN:VEVENT',
      `UID:${uid(row)}@sighttrue.com`,
      `DTSTAMP:${stamp}`,
      // An all-day event. A support deadline is a day, not a moment, and giving
      // it a time implies a precision the source does not have.
      `DTSTART;VALUE=DATE:${date}`,
      fold(`SUMMARY:${ics(`${name} reaches end of life`)}`),
      fold(
        `DESCRIPTION:${ics(
          `${name} stops receiving security fixes on this date.` +
            (row.lts ? ' This is an LTS release.' : '') +
            (row.latest ? ` Latest release in this cycle: ${row.latest}.` : '') +
            ' Checked against endoflife.date. See https://sighttrue.com/stack',
        )}`,
      ),
      'URL:https://sighttrue.com/stack',
      // Free rather than busy: it is a deadline to know about, not an
      // appointment, and marking it busy would corrupt the subscriber's
      // availability for a whole day.
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    ];
  });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Sighttrue — end of life',
    fold(
      'X-WR-CALDESC:Support deadlines for runtimes, databases and frameworks. ' +
        'Read from endoflife.date and republished as a subscribable feed. ' +
        'Every entry is checkable at https://sighttrue.com/stack',
    ),
    // A day. The dates move rarely, and a client polling harder than this is
    // spending somebody's battery on a file that changes a few times a month.
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
