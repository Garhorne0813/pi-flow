export const SCHEMA_VERSION = 4;
export type WorkerHealth = {
  workerId: string;
  heartbeatAt: number;
  lastSuccessfulTick?: number;
  lastClaimAt?: number;
  activeTasks: number;
  stopping: boolean;
  maintenance: "pending" | "ok" | "failed";
};
export async function bounded<T>(
  work: Promise<T>,
  timeoutMs = 1000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("PROBE_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
