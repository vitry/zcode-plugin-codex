#!/usr/bin/env node
// @ts-nocheck
// Hermetic compatibility snapshot of fd3e3c0 broker/health and
// broker/releaseOwner behavior: no capability advertisement and release
// parameters (including future exclusion cursors) are ignored.
import { readFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ZCodeBroker } from '../../scripts/zcode-broker.mjs';

class LegacyZCodeBrokerV1 extends ZCodeBroker {
  async handleLocal(socket, line) {
    let frame; try { frame = JSON.parse(line); } catch { return super.handleLocal(socket, line); }
    if (!this.authenticated.has(socket) || !frame || !Number.isSafeInteger(frame.id)) return super.handleLocal(socket, line);
    if (frame.method === 'broker/health') { this.writeLegacy(socket, { id: frame.id, result: { ok: true, pid: process.pid, instanceId: this.options.instanceId } }); return; }
    if (frame.method === 'broker/releaseOwner') {
      try { await this.reloadOwnership(); const result = await this.releaseOwner(socket, this.socketOwnerIds.get(socket), []); this.writeLegacy(socket, { id: frame.id, result }); this.fastIdleRequested = true; }
      catch (error) { this.writeLegacy(socket, { id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Legacy broker request failed' } }); }
      return;
    }
    return super.handleLocal(socket, line);
  }

  writeLegacy(socket, value) { if (!socket.writable) return; try { this.socketWriters.get(socket)?.write(`${JSON.stringify(value)}\n`); } catch { socket.destroy(); } }
}

async function main() {
  const configPath = process.argv[2]; if (!configPath) throw new Error('Legacy broker config is required.'); const config = JSON.parse(await readFile(configPath, 'utf8')); await unlink(configPath).catch(() => {}); const broker = await new LegacyZCodeBrokerV1(config).start(); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void broker.close().then(() => process.exit(0), () => process.exit(1)); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stderr.write(`Legacy ZCode broker failed: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exitCode = 1; });
