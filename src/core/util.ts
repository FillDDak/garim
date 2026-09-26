/** Escape a string for literal use inside a RegExp. */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
