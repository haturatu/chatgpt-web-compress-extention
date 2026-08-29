export const logger = {
  debug(message: string, ...args: unknown[]): void {
    console.debug(`[ChatGPT Optimizer] ${message}`, ...args);
  },
  info(message: string, ...args: unknown[]): void {
    console.info(`[ChatGPT Optimizer] ${message}`, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    console.warn(`[ChatGPT Optimizer] ${message}`, ...args);
  },
  error(message: string, ...args: unknown[]): void {
    console.error(`[ChatGPT Optimizer] ${message}`, ...args);
  }
};
