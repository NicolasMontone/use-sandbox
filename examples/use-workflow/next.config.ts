import type { NextConfig } from "next";
import { withSandbox } from "@use-sandbox/next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Your Next.js config here
};

// For now just use sandbox - workflow integration to be added once we
// figure out the package dependency situation
export default withSandbox(withWorkflow(nextConfig));
