/** Reads `base64(gzip(json))`, the form an export embeds its large payloads in. */
export async function inflateJson<A>(base64: string): Promise<A> {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as A;
}
