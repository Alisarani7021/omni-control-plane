/**
 * Stream plumbing for the tunnel.
 *
 * The hard part of a Workers proxy is not the protocol — it's backpressure.
 * If you copy bytes from a TCP socket into a WebSocket without honouring
 * `desiredSize`, the Worker's memory grows until the platform kills it and the
 * user's connection drops mid-download. Zeus hand-rolls this with
 * `waitForBackpressure` + a queue object; this is the same idea, smaller,
 * and it counts bytes for the ledger as it copies.
 */

/** @returns {Promise<{up:number, down:number}>} total bytes moved */
export async function pipeDuplex({ wsWritable, remoteSocket, onBytes, signal }) {
  let up = 0;
  let down = 0;
  const report = (u, d) => {
    up += u;
    down += d;
    onBytes?.(u, d);
  };

  // upstream: client → remote
  const toRemote = wsWritable.pipeTo(
    new WritableStream({
      async write(chunk, controller) {
        const writer = remoteSocket.writable.getWriter();
        try {
          await writer.write(chunk);
          report(chunk.byteLength ?? chunk.length, 0);
        } catch (e) {
          controller.error(e);
        } finally {
          writer.releaseLock();
        }
      },
      close() {
        remoteSocket.writable.close().catch(() => {});
      },
      abort() {
        remoteSocket.writable.abort().catch(() => {});
      },
    }),
    { signal },
  ).catch(() => {});

  // downstream: remote → client
  const toClient = remoteSocket.readable
    .pipeThrough(new TransformStream({
      transform(chunk, controller) {
        report(0, chunk.byteLength ?? chunk.length);
        controller.enqueue(chunk);
      },
    }))
    .pipeTo(new WritableStream({
      async write(chunk, controller) {
        // Respect WebSocket backpressure before writing more.
        while (true) {
          const state = wsWritable.desiredSize;
          if (state === null || state > 0) break;
          await new Promise((r) => setTimeout(r, 1));
        }
        try {
          controller.enqueue?.(chunk);
        } catch {}
      },
    }), { signal })
    .catch(() => {});

  await Promise.all([toRemote, toClient]);
  return { up, down };
}

/**
 * Copy a raw TCP socket to a WebSocket and back, the simple version that works
 * for 99% of traffic. `webSocket.send()` on CF Workers already buffers, so we
 * only need to release the writer between chunks.
 */
export async function tunnel({ webSocket, remoteSocket, onBytes }) {
  let up = 0;
  let down = 0;

  const remoteReader = remoteSocket.readable.getReader();
  const wsWriter = webSocket.writableStream?.getWriter?.() ?? null;

  const pumpDown = async () => {
    try {
      while (true) {
        const { done, value } = await remoteReader.read();
        if (done) break;
        down += value.byteLength;
        onBytes?.(0, value.byteLength);
        if (webSocket.readyState === WebSocket.OPEN) webSocket.send(value);
        else break;
      }
    } catch {
      /* connection reset by peer — normal at the edge */
    } finally {
      remoteReader.releaseLock();
      try { webSocket.close(1000, "remote closed"); } catch {}
    }
  };

  const pumpUp = () =>
    new Promise((resolve) => {
      webSocket.addEventListener("message", async (event) => {
        // See toBytes() in vless.js — a binary frame arrives as a Blob unless
        // binaryType is set, and String(blob) yields "[object Blob]".
        const data = await (event.data instanceof ArrayBuffer
          ? Promise.resolve(new Uint8Array(event.data))
          : typeof event.data === "string"
            ? Promise.resolve(new TextEncoder().encode(event.data))
            : new Response(event.data).arrayBuffer().then((b) => new Uint8Array(b)));
        up += data.byteLength;
        onBytes?.(data.byteLength, 0);
        try {
          const writer = remoteSocket.writable.getWriter();
          await writer.write(data);
          writer.releaseLock();
        } catch {
          resolve();
        }
      });
      webSocket.addEventListener("close", () => resolve());
      webSocket.addEventListener("error", () => resolve());
    });

  await Promise.allSettled([pumpDown(), pumpUp()]);
  return { up, down };
}
