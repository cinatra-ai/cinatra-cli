// The concrete provider implementation for {{packageName}}.
//
// Replace this stub with your connector's real provider object. The host routes
// the capability registered in ./register to this implementation. Keep all
// host-coupling behind the SDK's ExtensionHostContext ports — do not import
// host-internal packages.

export const {{pascalBase}}ConnectorId = "{{slug}}";

/**
 * The provider implementation handed to ctx.capabilities.registerProvider.
 * Shape it to match the capability contract you are serving (see the
 * @cinatra-ai/sdk-extensions capability/contract types).
 */
export const {{camelBase}}Provider = {
  id: {{pascalBase}}ConnectorId,
  // ...implement the capability methods here.
};
