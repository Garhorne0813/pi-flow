import type pg from "pg";
export async function sqlMetrics(pool: pg.Pool) {
  let enabled = false;
  const records: {
    sql: string;
    command: string;
    rows: number;
    bytes: number;
  }[] = [];
  const seen = new WeakSet<pg.PoolClient>();
  const install = (c: pg.PoolClient) => {
    if (seen.has(c)) return;
    seen.add(c);
    const query = c.query.bind(c);
    c.query = ((...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? ""),
        active = enabled;
      const capture = (r: any) => {
        if (active)
          records.push({
            sql,
            command: r.command,
            rows: r.rows?.length ?? 0,
            bytes: Buffer.byteLength(JSON.stringify(r.rows ?? [])),
          });
        return r;
      };
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = (e: unknown, r: unknown) => {
          if (!e) capture(r);
          callback(e, r);
        };
        return (query as any)(...args);
      }
      return (query as any)(...args).then(capture);
    }) as typeof c.query;
  };
  pool.on("connect", install);
  const c = await pool.connect();
  install(c);
  c.release();
  return {
    start: () => {
      records.length = 0;
      enabled = true;
    },
    stop: () => {
      enabled = false;
      return [...records];
    },
  };
}
