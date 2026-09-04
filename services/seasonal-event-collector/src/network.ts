import type { Page, Response } from "playwright";

export interface NetworkRetryDiagnostic {
  url: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface NetworkOptions {
  attempts?: number;
  baseDelayMs?: number;
  onRetry?: (diagnostic: NetworkRetryDiagnostic) => void;
}

class HttpNavigationError extends Error {
  public constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} while loading ${url}`);
  }
}

export async function navigateWithRetry(
  page: Page,
  url: string,
  options: NetworkOptions = {},
): Promise<Response> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  return retryOperation(async () => {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!response) throw new Error(`navigation returned no response: ${url}`);
    if (!response.ok()) throw new HttpNavigationError(response.status(), url);
    return response;
  }, {
    attempts,
    baseDelayMs,
    shouldRetry: error => !(error instanceof HttpNavigationError) || error.status === 408 || error.status === 429 || error.status >= 500,
    onRetry: diagnostic => options.onRetry?.({ url, ...diagnostic }),
  });
}

export async function retryOperation<T>(
  operation: () => Promise<T>,
  options: {
    attempts: number;
    baseDelayMs: number;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (diagnostic: Omit<NetworkRetryDiagnostic, "url">) => void;
  },
): Promise<T> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) throw new Error("retry attempts must be a positive integer");
  if (!Number.isInteger(options.baseDelayMs) || options.baseDelayMs < 0) throw new Error("retry delay must be a non-negative integer");

  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= options.attempts || options.shouldRetry?.(error) === false) throw error;
      const delayMs = Math.min(options.baseDelayMs * attempt, 10000);
      options.onRetry?.({
        attempt,
        maxAttempts: options.attempts,
        delayMs,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
