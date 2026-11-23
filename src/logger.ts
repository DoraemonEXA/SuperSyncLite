export const Logger = {
  debug(..._values: unknown[]) {},
  info(...values: unknown[]) {
    console.info(...values);
  },
  warn(...values: unknown[]) {
    console.warn(...values);
  },
  error(...values: unknown[]) {
    console.error(...values);
  },
  audit(event: object) {
    console.info(event);
  },
};
