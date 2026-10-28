import * as v from 'valibot';
import { type TourEvent, TourEventSchema } from './events.ts';

export function encodeSse(event: TourEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function encodeNdjson(event: TourEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Validates one event at the trust boundary; a malformed event is a protocol bug, so it throws. */
export function parseEvent(json: unknown): TourEvent {
  return v.parse(TourEventSchema, json) as TourEvent;
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parses an SSE body into events. `fetch` streams are used instead of `EventSource`
 * because `EventSource` cannot send an `Authorization` header (needed for a remote backend).
 */
export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<TourEvent> {
  let data: string[] = [];
  for await (const line of lines(stream)) {
    if (line === '') {
      if (data.length) {
        yield parseEvent(JSON.parse(data.join('\n')));
        data = [];
      }
      continue;
    }
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) {
    yield parseEvent(JSON.parse(data.join('\n')));
  }
}

export async function* parseNdjsonStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<TourEvent> {
  for await (const line of lines(stream)) {
    if (line.trim()) {
      yield parseEvent(JSON.parse(line));
    }
  }
}
