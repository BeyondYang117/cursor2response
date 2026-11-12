// SDK callbacks are synchronous. Bound their writes and pause stream consumption
// at the next event boundary until the current HTTP subscriber drains.
export function createNdjsonWriter(response, signal, maxBufferedBytes = 32 * 1024 * 1024) {
  let blocked = false;
  let ready = Promise.resolve(true);
  let release;
  let closed = false;
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
  const onClose = () => { closed = true; finish(false); };
  const write = (event) => {
    if (closed || response.destroyed || response.writableEnded || signal?.aborted) return false;
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    if (response.writableLength + bytes.length > maxBufferedBytes) {
      response.destroy();
      return false;
    }
    let writable;
    try {
      writable = response.write(bytes);
    } catch (error) {
      if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error?.code)) throw error;
      onClose();
      return false;
    }
    if (!writable && !blocked) {
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
  write.drain = async () => (await ready) && !closed && !response.destroyed && !response.writableEnded && !signal?.aborted;
  return { write, close: onClose };
}
