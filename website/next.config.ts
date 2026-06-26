import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "export",
  distDir: "dist",
  outputFileTracingRoot: path.resolve(__dirname),
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
