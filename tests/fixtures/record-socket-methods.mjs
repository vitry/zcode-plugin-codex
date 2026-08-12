// @ts-nocheck
import { appendFileSync } from 'node:fs';
import net from 'node:net';

const recordPath = process.env.ZCODE_TEST_SOCKET_METHOD_RECORD;
if (recordPath) {
  const write = net.Socket.prototype.write;
  net.Socket.prototype.write = function instrumentedWrite(chunk, ...args) {
    try {
      const frame = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      if (typeof frame?.method === 'string') appendFileSync(recordPath, `${frame.method}\n`);
    } catch { /* Only complete JSON-RPC request frames are diagnostic evidence. */ }
    return write.call(this, chunk, ...args);
  };
}
