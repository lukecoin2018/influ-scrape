import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Pin the workspace root to this project.
   *
   * Next infers the root by walking up for lockfiles, and a stray
   * package-lock.json in the developer's home directory outranked this
   * project's own — the build reported selecting that directory instead.
   * Root affects module resolution and output file tracing, so leaving it
   * inferred risks local and deployed builds disagreeing for reasons that have
   * nothing to do with the code.
   *
   * Set from this file's own location rather than process.cwd(), so it stays
   * correct whatever directory the build is invoked from.
   */
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
};

export default nextConfig;
