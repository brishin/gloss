declare module 'virtual:gloss-grammars' {
  /** Every shiki grammar by name, as base64(gzip(JSON)). */
  export const GRAMMARS: string;
  /** Each language (and alias) and the grammars it loads, in order. */
  export const LANGUAGES: Record<string, string[]>;
}
