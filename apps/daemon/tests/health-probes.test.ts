// @ts-nocheck
import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// We test the /health/live and /health/ready handlers as pure functions
// of (db, agentList) so we don't need to bring up the full daemon. The
// production handlers in server.ts wire the same logic to real db /
// detectAgents() — see server.ts §"Split health probes".

interface HealthDeps {
  db: { ping: () => boolean };
  detectAgents: () => Promise<Array<{ bin?: string; installed?: boolean }>>;
}

function mountHealthRoutes(app: express.Express, deps: HealthDeps) {
  app.get('/health/live', (_req, res) => {
    res.json({ live: true, pid: process.pid, uptimeSec: Math.round(process.uptime()) });
  });
  app.get('/health/ready', async (_req, res) => {
    const reasons: string[] = [];
    let dbOk = false;
    try {
      dbOk = deps.db.ping();
    } catch (err) {
      reasons.push(`db: ${String((err as Error).message)}`);
    }
    let agentsOk = false;
    let agentCount = 0;
    try {
      const agents = await deps.detectAgents();
      agentCount = Array.isArray(agents) ? agents.length : 0;
      agentsOk = Array.isArray(agents) && agents.some((a) => a && a.installed !== false && a.bin);
      if (!agentsOk) reasons.push('agents: none installed');
    } catch (err) {
      reasons.push(`agents: ${String((err as Error).message)}`);
    }
    const ready = dbOk && agentsOk;
    res.status(ready ? 200 : 503).json({
      ready,
      checks: { db: dbOk, agents: agentsOk, agentCount },
      reasons: reasons.length > 0 ? reasons : undefined,
    });
  });
}

function makeApp(deps: HealthDeps): express.Express {
  const app = express();
  mountHealthRoutes(app, deps);
  return app;
}

describe('health probes', () => {
  let server: http.Server;
  let baseUrl: string;
  let depsRef: HealthDeps;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        // Mutable deps so individual tests can flip state without restart.
        depsRef = {
          db: { ping: () => true },
          detectAgents: async () => [{ bin: '/usr/bin/claude', installed: true }],
        };
        const app = makeApp({
          db: { ping: () => depsRef.db.ping() },
          detectAgents: () => depsRef.detectAgents(),
        });
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
  );

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('/health/live returns 200 with pid and uptime regardless of state', async () => {
    depsRef.db = { ping: () => false };
    depsRef.detectAgents = async () => [];
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.live).toBe(true);
    expect(typeof body.pid).toBe('number');
    expect(typeof body.uptimeSec).toBe('number');
  });

  it('/health/ready returns 200 when db is open and at least one agent is installed', async () => {
    depsRef.db = { ping: () => true };
    depsRef.detectAgents = async () => [
      { bin: '/usr/bin/claude', installed: true },
      { bin: undefined, installed: false },
    ];
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(true);
    expect(body.checks).toEqual({ db: true, agents: true, agentCount: 2 });
  });

  it('/health/ready returns 503 when no agent is installed', async () => {
    depsRef.db = { ping: () => true };
    depsRef.detectAgents = async () => [{ bin: undefined, installed: false }];
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.checks.agents).toBe(false);
    expect(body.reasons.join(' ')).toContain('none installed');
  });

  it('/health/ready returns 503 with structured reason when db is down', async () => {
    depsRef.db = {
      ping: () => {
        throw new Error('db is locked');
      },
    };
    depsRef.detectAgents = async () => [{ bin: '/usr/bin/claude', installed: true }];
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.checks.db).toBe(false);
    expect(body.reasons.join(' ')).toContain('db: db is locked');
  });

  it('/health/ready returns 503 when both db and agents fail', async () => {
    depsRef.db = {
      ping: () => {
        throw new Error('boom');
      },
    };
    depsRef.detectAgents = async () => {
      throw new Error('detect failed');
    };
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(body.reasons).toHaveLength(2);
  });
});
