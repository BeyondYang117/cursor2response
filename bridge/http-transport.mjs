// SDK callbacks are synchronous. Bound their writes and pause stream consumption
// at the next event boundary until the current HTTP subscriber drains.
export function createNdjsonWriter(response, signal, maxBufferedBytes = 32 * 1024 * 1024) {
  let blocked = false;
  let ready = Promise.resolve(true);
  let release;
  const finish = (ok) => {
    response.off("drain", onDrain);
    response.off("close", onClose);
    response.off("error", onClose);
    signal?.removeEventListener("abort", onClose);
    blocked = false;
    release?.(ok);
    release = undefined;
  };
  const onDrain = () => finish(true);
  const onClose = () => finish(false);
  const write = (event) => {
    if (response.destroyed || response.writableEnded || signal?.aborted) return false;
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    if (response.writableLength + bytes.length > maxBufferedBytes) {
      response.destroy();
      return false;
    }
    if (!response.write(bytes) && !blocked) {
      blocked = true;
      ready = new Promise((resolve) => { release = resolve; });
      response.once("drain", onDrain);
      response.once("close", onClose);
      response.once("error", onClose);
      signal?.addEventListener("abort", onClose, { once: true });
      if (response.destroyed || signal?.aborted) onClose();
    }
    return true;
  };
  write.drain = async () => (await ready) && !response.destroyed && !response.writableEnded && !signal?.aborted;
  return { write, close: onClose };
}
