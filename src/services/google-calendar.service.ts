// Operaciones sobre Google Calendar (API v3) con el cliente OAuth por client_id.
// Scope: calendar.events (lectura/escritura de eventos). Disponibilidad se infiere
// listando eventos del rango (no usamos freebusy para no pedir calendar.readonly).
import { google, calendar_v3 } from 'googleapis';
import { googleApiService } from './google-api.service';

async function calendarClient(clientId: number) {
  const auth = await googleApiService.authorizedClient(clientId);
  return google.calendar({ version: 'v3', auth });
}

// Normaliza una fecha/hora a RFC3339. Si viene solo fecha (YYYY-MM-DD), la expande
// al inicio o fin del día (UTC). Si ya trae hora, se devuelve tal cual.
function toRfc3339(value: string, edge: 'start' | 'end'): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return edge === 'start' ? `${v}T00:00:00Z` : `${v}T23:59:59Z`;
  }
  return v;
}

// Forma compacta de un evento (lo que recibe el agente).
function shapeEvent(e: calendar_v3.Schema$Event): Record<string, unknown> {
  return {
    id: e.id,
    summary: e.summary ?? null,
    description: e.description ?? null,
    location: e.location ?? null,
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    attendees: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
    status: e.status ?? null,
    html_link: e.htmlLink ?? null,
  };
}

export type CreateEventInput = {
  summary: string;
  description?: string;
  location?: string;
  start: string; // ISO datetime
  end: string; // ISO datetime
  timezone?: string;
  attendees?: string[];
};

export type UpdateEventInput = {
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timezone?: string;
  attendees?: string[];
};

export const googleCalendarService = {
  async listEvents(
    clientId: number,
    calendarId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<Record<string, unknown>[]> {
    const cal = await calendarClient(clientId);
    const res = await cal.events.list({
      calendarId,
      timeMin: toRfc3339(timeMin, 'start'),
      timeMax: toRfc3339(timeMax, 'end'),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    return (res.data.items ?? []).map(shapeEvent);
  },

  /**
   * Disponibilidad inferida: lista los eventos del rango y devuelve los bloques
   * ocupados + si el rango está libre. Sin scope extra (usa events.list).
   */
  async checkAvailability(
    clientId: number,
    calendarId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<{ free: boolean; busy: { start: string | null; end: string | null; summary: string | null }[] }> {
    const cal = await calendarClient(clientId);
    const res = await cal.events.list({
      calendarId,
      timeMin: toRfc3339(timeMin, 'start'),
      timeMax: toRfc3339(timeMax, 'end'),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });
    const busy = (res.data.items ?? [])
      // ignorar eventos en los que el cliente marcó "libre" (transparency)
      .filter((e) => e.transparency !== 'transparent' && e.status !== 'cancelled')
      .map((e) => ({
        start: e.start?.dateTime ?? e.start?.date ?? null,
        end: e.end?.dateTime ?? e.end?.date ?? null,
        summary: e.summary ?? null,
      }));
    return { free: busy.length === 0, busy };
  },

  async createEvent(
    clientId: number,
    calendarId: string,
    input: CreateEventInput,
  ): Promise<Record<string, unknown>> {
    const cal = await calendarClient(clientId);
    const res = await cal.events.insert({
      calendarId,
      requestBody: {
        summary: input.summary,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start, timeZone: input.timezone },
        end: { dateTime: input.end, timeZone: input.timezone },
        attendees: (input.attendees ?? []).map((email) => ({ email })),
      },
    });
    return shapeEvent(res.data);
  },

  async updateEvent(
    clientId: number,
    calendarId: string,
    eventId: string,
    input: UpdateEventInput,
  ): Promise<Record<string, unknown>> {
    const cal = await calendarClient(clientId);
    const requestBody: calendar_v3.Schema$Event = {};
    if (input.summary !== undefined) requestBody.summary = input.summary;
    if (input.description !== undefined) requestBody.description = input.description;
    if (input.location !== undefined) requestBody.location = input.location;
    if (input.start !== undefined) requestBody.start = { dateTime: input.start, timeZone: input.timezone };
    if (input.end !== undefined) requestBody.end = { dateTime: input.end, timeZone: input.timezone };
    if (input.attendees !== undefined) requestBody.attendees = input.attendees.map((email) => ({ email }));

    const res = await cal.events.patch({ calendarId, eventId, requestBody });
    return shapeEvent(res.data);
  },

  async deleteEvent(clientId: number, calendarId: string, eventId: string): Promise<void> {
    const cal = await calendarClient(clientId);
    await cal.events.delete({ calendarId, eventId });
  },
};
