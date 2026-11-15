import type { ServerRecord } from "../types.js";

export interface BrowserConnectionPorts {
  backendPort: number;
  wakePort: number;
}

/** One source of truth for the public game address and the isolated JVM listener. */
export class GameConnectionResolver {
  constructor(
    private readonly browserPorts: (
      id: string,
    ) => BrowserConnectionPorts | null = () => null,
  ) {}

  resolve(server: ServerRecord): {
    publicPort: number;
    backendPort: number;
    browserWakePort: number | null;
  } {
    const ports = this.browserPorts(server.id);
    return {
      publicPort: server.port,
      backendPort: ports?.backendPort ?? server.port,
      browserWakePort: ports?.wakePort ?? null,
    };
  }
}
