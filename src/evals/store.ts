import type { EvalCase } from "./types.js";
export type Suite = {
  id: string;
  userId: string;
  name: string;
  description: string;
  currentVersion: number;
  draftRevision: number;
  cases: EvalCase[];
  createdAt: string;
  updatedAt: string;
};
export type SuiteVersion = {
  suiteId: string;
  version: number;
  specDigest: string;
  createdAt: string;
  createdBy: string;
};
export type Page = { offset: number; limit: number };
export interface EvalStore {
  listSuites(user: string, page: Page): Promise<Omit<Suite, "cases">[]>;
  getSuite(user: string, id: string): Promise<Suite>;
  createSuite(suite: Suite): Promise<Suite>;
  patchSuite(
    user: string,
    id: string,
    revision: number,
    patch: Pick<Suite, "name" | "description" | "cases">,
  ): Promise<Suite>;
  deleteSuite(user: string, id: string): Promise<void>;
  publish(user: string, id: string, revision: number): Promise<SuiteVersion>;
  versions(user: string, id: string, page: Page): Promise<SuiteVersion[]>;
  version(user: string, id: string, version: number): Promise<SuiteVersion>;
  cases(
    user: string,
    id: string,
    version: number,
    page: Page,
  ): Promise<EvalCase[]>;
}
