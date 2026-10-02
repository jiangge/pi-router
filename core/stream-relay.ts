import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

export type RelayProviderStreamResult =
  | { ok: true }
  | { ok: false; error: string; aborted: boolean; committed: boolean };

const providerStreamAborters = new WeakMap<AssistantMessageEventStream, () => void>();

export function registerProviderStreamAborter(
  stream: AssistantMessageEventStream,
  aborter: () => void,
): () => void {
  providerStreamAborters.set(stream, aborter);
  return () => providerStreamAborters.delete(stream);
}

function abortProviderStream(stream: AssistantMessageEventStream): void {
  providerStreamAborters.get(stream)?.();
}

export function createLinkedAbortController(signal?: AbortSignal): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  let abortHandler: (() => void) | undefined;

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      abortHandler = () => controller.abort();
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  return {
    controller,
    cleanup: () => {
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    },
  };
}

export function getStreamEventFailure(event: AssistantMessageEvent): string | undefined {
  if (event.type !== "error") return undefined;

  const errorMessage = event.error.errorMessage;
  if (typeof errorMessage === "string" && errorMessage.trim().length > 0) {
    return errorMessage;
  }

  return "Provider stream returned an error event";
}

function isResponseCommitEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "done":
    case "toolcall_start":
    case "toolcall_end":
      return true;
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return !!event.delta;
    case "text_end":
      return !!event.content;
    case "thinking_end":
      return !!event.content;
    default:
      return false;
  }
}

async function nextStreamEventWithTimeout(
  iterator: AsyncIterator<AssistantMessageEvent>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IteratorResult<AssistantMessageEvent>> {
  if (signal?.aborted) throw new Error("Request was aborted");

  let timeout: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  try {
    return await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) => {
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          reject(new Error(`Router attempt timed out after ${timeoutMs}ms waiting for provider stream`));
        }, timeoutMs);
      }

      abortHandler = () => reject(new Error("Request was aborted"));
      signal?.addEventListener("abort", abortHandler, { once: true });
      iterator.next().then(resolve, reject);
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

export function getRouterTimeoutMs(
  options: SimpleStreamOptions | undefined,
  configuredTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
): number {
  if (configuredTimeoutMs !== undefined) return configuredTimeoutMs;

  const incomingTimeoutMs = options?.timeoutMs;
  if (incomingTimeoutMs !== undefined && incomingTimeoutMs > defaultTimeoutMs) {
    return incomingTimeoutMs;
  }
  return defaultTimeoutMs;
}

export async function relayProviderStream(
  stream: AssistantMessageEventStream,
  outputStream: AssistantMessageEventStream,
  options: SimpleStreamOptions | undefined,
  timeoutMs: number,
  onCommit: () => void,
): Promise<RelayProviderStreamResult> {
  const iterator = stream[Symbol.asyncIterator]();
  const bufferedEvents: AssistantMessageEvent[] = [];
  let committed = false;
  let terminalPushed = false;

  try {
    while (true) {
      const result = await nextStreamEventWithTimeout(iterator, timeoutMs, options?.signal);
      if (result.done) {
        if (terminalPushed) return { ok: true };
        throw new Error(committed
          ? "Provider stream ended before final message"
          : "Provider stream ended before producing a response");
      }

      const event = result.value;
      const failure = getStreamEventFailure(event);
      if (failure) throw new Error(failure);

      if (!committed) {
        if (isResponseCommitEvent(event)) {
          onCommit();
          committed = true;
          for (const bufferedEvent of bufferedEvents) outputStream.push(bufferedEvent);
          bufferedEvents.length = 0;
          outputStream.push(event);
        } else {
          bufferedEvents.push(event);
        }
      } else {
        outputStream.push(event);
      }

      if (event.type === "done") terminalPushed = true;
    }
  } catch (err) {
    abortProviderStream(stream);
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error,
      aborted: isAbortError(error) || isAbortSignalAborted(options),
      committed,
    };
  }
}

export function isAbortError(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes("aborted") || lower.includes("aborterror") || lower.includes("the operation was aborted");
}

export function isAbortSignalAborted(options: SimpleStreamOptions | undefined): boolean {
  return !!options?.signal?.aborted;
}
