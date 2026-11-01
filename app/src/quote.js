// Quoting for text the app suggests copying into a terminal or a .env file.
// Item names and values can come from someone else's share, so they must
// always arrive as literal text, never as shell syntax.

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One literal argument for a POSIX shell. */
export const shellQuote = (s) => (PLAIN.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * A .env value. Single quotes are literal both to dotenv parsers and to a shell
 * that sources the file; values they can't hold fall back to double quotes.
 */
export const dotenvValue = (v) => (v === '' || PLAIN.test(v) ? v : /['\n\r]/.test(v) ? JSON.stringify(v) : `'${v}'`);
