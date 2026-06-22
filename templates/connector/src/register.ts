// The {{slug}} connector's `register(ctx)` server entry.
//
// The host's extension loader dynamic-imports this module and calls
// `register(ctx)`. The host context's `capabilities` port routes a named
// capability to your concrete provider. Capability-based: the connector
// advertises a capability id; the host resolves which concrete provider serves
// it.
//
// `@cinatra-ai/sdk-extensions` is an OPTIONAL peer — the host workspace provides
// it. It is never installed from a registry by this template.

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { {{camelBase}}Provider } from "./provider";

export function register(ctx: ExtensionHostContext): void {
  // Replace "example-capability" with the capability id your connector serves,
  // and wire the concrete implementation.
  ctx.capabilities.registerProvider("example-capability", {
    packageName: "{{packageName}}",
    impl: {{camelBase}}Provider,
  });
}
