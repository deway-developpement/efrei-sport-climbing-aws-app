import { fetchCalendarEventsFromUrl, parseCalendarEvents } from '../../../../layers/commons/calendar.events';

describe('calendar.events', () => {
    it('parses timed ICS events overlapping the requested range', () => {
        const events = parseCalendarEvents(
            [
                'BEGIN:VCALENDAR',
                'BEGIN:VEVENT',
                'SUMMARY:Cours',
                'DTSTART;TZID=Europe/Paris:20260324T180000',
                'DTEND;TZID=Europe/Paris:20260324T193000',
                'LOCATION:Campus',
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n'),
            {
                start: new Date('2026-03-24T00:00:00.000Z'),
                end: new Date('2026-03-25T00:00:00.000Z'),
            },
        );

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            title: 'Cours',
            location: 'Campus',
            allDay: false,
        });
        expect(events[0].startIso).toBe('2026-03-24T17:00:00.000Z');
        expect(events[0].endIso).toBe('2026-03-24T18:30:00.000Z');
    });

    it('parses all-day ICS events and filters non-overlapping ones', () => {
        const events = parseCalendarEvents(
            [
                'BEGIN:VCALENDAR',
                'BEGIN:VEVENT',
                'SUMMARY:Journée off',
                'DTSTART;VALUE=DATE:20260326',
                'DTEND;VALUE=DATE:20260327',
                'END:VEVENT',
                'BEGIN:VEVENT',
                'SUMMARY:Hors fenêtre',
                'DTSTART;VALUE=DATE:20260410',
                'DTEND;VALUE=DATE:20260411',
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n'),
            {
                start: new Date('2026-03-25T00:00:00.000Z'),
                end: new Date('2026-03-28T00:00:00.000Z'),
            },
        );

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            title: 'Journée off',
            allDay: true,
            startIso: '2026-03-26T00:00:00.000Z',
            endIso: '2026-03-27T00:00:00.000Z',
        });
    });

    it('fetches ICS content through fetch before parsing', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () =>
                [
                    'BEGIN:VCALENDAR',
                    'BEGIN:VEVENT',
                    'SUMMARY:Réunion',
                    'DTSTART:20260324T120000Z',
                    'DTEND:20260324T130000Z',
                    'END:VEVENT',
                    'END:VCALENDAR',
                ].join('\r\n'),
        } as Response);

        try {
            const events = await fetchCalendarEventsFromUrl('https://example.com/calendar.ics', {
                start: new Date('2026-03-24T00:00:00.000Z'),
                end: new Date('2026-03-25T00:00:00.000Z'),
            });

            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                title: 'Réunion',
                startIso: '2026-03-24T12:00:00.000Z',
                endIso: '2026-03-24T13:00:00.000Z',
            });
        } finally {
            global.fetch = originalFetch;
        }
    });
});
