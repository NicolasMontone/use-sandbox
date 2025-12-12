import { defineSandbox } from "@use-sandbox/core";

export const sandbox = defineSandbox({
  resources: { vcpus: 2 },
  timeout: 300_000,
});
