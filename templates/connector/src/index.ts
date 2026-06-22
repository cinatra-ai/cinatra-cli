// Public surface of {{packageName}}.
//
// Re-export the connector's public definition + implementation here. Keep the
// `register(ctx)` server entry in ./register (the host loader imports it via the
// "./register" export). This barrel is the "." export consumed by callers that
// import the connector's types/helpers directly.

export { {{camelBase}}Provider, {{pascalBase}}ConnectorId } from "./provider";
