import { getUserCalendarFeed } from './dynamodb.user_calendar_feeds';

export type CalendarEvent = {
    title: string;
    startIso: string;
    endIso: string;
    allDay?: boolean;
    location?: string | null;
};

export type CalendarRange = {
    start: Date;
    end: Date;
};

const DEFAULT_TIME_ZONE = 'Europe/Paris';

function unfoldIcsLines(content: string): string[] {
    return content
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .reduce<string[]>((lines, line) => {
            if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
                lines[lines.length - 1] += line.slice(1);
            } else {
                lines.push(line);
            }
            return lines;
        }, [])
        .filter((line) => line.length > 0);
}

function parseProperty(line: string): { name: string; value: string; params: Record<string, string> } {
    const [rawKey, ...rest] = line.split(':');
    const value = rest.join(':');
    const [name, ...paramPairs] = rawKey.split(';');
    const params = paramPairs.reduce<Record<string, string>>((accumulator, pair) => {
        const [paramName, paramValue] = pair.split('=');
        if (paramName && paramValue) {
            accumulator[paramName.toUpperCase()] = paramValue;
        }
        return accumulator;
    }, {});

    return {
        name: name.toUpperCase(),
        value,
        params,
    };
}

function getTimeZoneOffsetMilliseconds(date: Date, timezone: string): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'shortOffset',
    });
    const timeZoneName = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
    const match = timeZoneName?.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) {
        return 0;
    }
    const sign = match[1] === '-' ? -1 : 1;
    const hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return sign * (hours * 60 + minutes) * 60 * 1000;
}

function buildZonedDate(year: number, month: number, day: number, hour: number, minute: number, second: number, timezone: string): Date {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
    const initialOffset = getTimeZoneOffsetMilliseconds(utcGuess, timezone);
    let resolved = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0) - initialOffset);
    const resolvedOffset = getTimeZoneOffsetMilliseconds(resolved, timezone);
    if (resolvedOffset !== initialOffset) {
        resolved = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0) - resolvedOffset);
    }
    return resolved;
}

function parseIcsDateTime(value: string, params: Record<string, string>): { date: Date; allDay: boolean } {
    if (params.VALUE === 'DATE') {
        const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (!match) {
            throw new Error(`Invalid ICS all-day date: ${value}`);
        }
        return {
            date: new Date(Date.UTC(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10), 0, 0, 0, 0)),
            allDay: true,
        };
    }

    if (value.endsWith('Z')) {
        const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
        if (!match) {
            throw new Error(`Invalid ICS UTC datetime: ${value}`);
        }
        return {
            date: new Date(
                Date.UTC(
                    parseInt(match[1], 10),
                    parseInt(match[2], 10) - 1,
                    parseInt(match[3], 10),
                    parseInt(match[4], 10),
                    parseInt(match[5], 10),
                    parseInt(match[6], 10),
                    0,
                ),
            ),
            allDay: false,
        };
    }

    const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
    if (!match) {
        throw new Error(`Invalid ICS local datetime: ${value}`);
    }

    return {
        date: buildZonedDate(
            parseInt(match[1], 10),
            parseInt(match[2], 10),
            parseInt(match[3], 10),
            parseInt(match[4], 10),
            parseInt(match[5], 10),
            parseInt(match[6], 10),
            params.TZID || DEFAULT_TIME_ZONE,
        ),
        allDay: false,
    };
}

function overlaps(range: CalendarRange, start: Date, end: Date): boolean {
    return start < range.end && end > range.start;
}

export function parseCalendarEvents(icsContent: string, range: CalendarRange): CalendarEvent[] {
    const lines = unfoldIcsLines(icsContent);
    const events: CalendarEvent[] = [];
    let currentEvent: Record<string, { value: string; params: Record<string, string> }> | null = null;

    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') {
            currentEvent = {};
            continue;
        }
        if (line === 'END:VEVENT') {
            if (currentEvent?.DTSTART) {
                try {
                    const start = parseIcsDateTime(currentEvent.DTSTART.value, currentEvent.DTSTART.params);
                    const endSource = currentEvent.DTEND
                        ? parseIcsDateTime(currentEvent.DTEND.value, currentEvent.DTEND.params)
                        : null;
                    const end = endSource?.date || new Date(start.date.getTime() + (start.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000));
                    if (overlaps(range, start.date, end)) {
                        events.push({
                            title: currentEvent.SUMMARY?.value || 'Busy',
                            startIso: start.date.toISOString(),
                            endIso: end.toISOString(),
                            allDay: start.allDay,
                            location: currentEvent.LOCATION?.value || null,
                        });
                    }
                } catch (error) {
                    console.warn('Skipping invalid ICS event', error);
                }
            }
            currentEvent = null;
            continue;
        }
        if (!currentEvent) {
            continue;
        }
        const property = parseProperty(line);
        currentEvent[property.name] = { value: property.value, params: property.params };
    }

    return events.sort((left, right) => left.startIso.localeCompare(right.startIso));
}

export async function fetchCalendarEventsFromUrl(url: string, range: CalendarRange): Promise<CalendarEvent[]> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ICS feed: ${response.status} ${response.statusText}`);
    }
    const content = await response.text();
    return parseCalendarEvents(content, range);
}

export async function getCalendarEventsForUser(userId: string, range: CalendarRange): Promise<{
    events: CalendarEvent[];
    missingCalendarFeed: boolean;
    calendarUrl: string | null;
}> {
    const feed = await getUserCalendarFeed(userId);
    if (!feed?.calendarUrl) {
        return {
            events: [],
            missingCalendarFeed: true,
            calendarUrl: null,
        };
    }

    return {
        events: await fetchCalendarEventsFromUrl(feed.calendarUrl, range),
        missingCalendarFeed: false,
        calendarUrl: feed.calendarUrl,
    };
}
