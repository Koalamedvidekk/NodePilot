import os from 'node:os';
import { mkdir, statfs } from 'node:fs/promises';

import type { ServerRepository } from '../repositories/server-repository.js';

type CpuTotals = { idle: number; total: number };

function cpuTotals(): CpuTotals {
  return os.cpus().reduce<CpuTotals>((accumulator, cpu) => {
    const times = cpu.times;
    accumulator.idle += times.idle;
    accumulator.total += times.user + times.nice + times.sys + times.idle + times.irq;
    return accumulator;
  }, { idle: 0, total: 0 });
}

export class SystemService {
  private lastCpu = cpuTotals();

  constructor(
    private readonly repository: ServerRepository,
    private readonly dataDirectory: string,
  ) {}

  async summary() {
    const nowCpu = cpuTotals();
    const deltaTotal = nowCpu.total - this.lastCpu.total;
    const deltaIdle = nowCpu.idle - this.lastCpu.idle;
    this.lastCpu = nowCpu;
    const cpuUsage = deltaTotal > 0 ? Math.max(0, Math.min(100, ((deltaTotal - deltaIdle) / deltaTotal) * 100)) : 0;
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();

    let disk: { usedBytes: number; totalBytes: number; usagePercent: number; path: string } | undefined;
    try {
      await mkdir(this.dataDirectory, { recursive: true });
      const info = await statfs(this.dataDirectory);
      const blockSize = Number(info.bsize);
      const totalBytes = Number(info.blocks) * blockSize;
      const availableBytes = Number(info.bavail) * blockSize;
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      disk = {
        usedBytes,
        totalBytes,
        usagePercent: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
        path: this.dataDirectory,
      };
    } catch {
      // Disk values are optional; unlike synthetic statistics, absent values are honest.
    }

    return {
      cpu: {
        usagePercent: Number(cpuUsage.toFixed(1)),
        cores: os.cpus().length,
        model: os.cpus()[0]?.model,
      },
      memory: {
        usedBytes: totalMemory - freeMemory,
        totalBytes: totalMemory,
        usagePercent: Number((((totalMemory - freeMemory) / totalMemory) * 100).toFixed(1)),
      },
      disk,
      platform: `${os.platform()} ${os.release()}`,
      hostname: os.hostname(),
      uptimeSeconds: Math.floor(os.uptime()),
      activeServers: this.repository.list().filter((server) => ['starting', 'running', 'stopping'].includes(server.status)).length,
    };
  }
}
