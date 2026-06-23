// Fetch-poison preload (eng#232 §3 server-down guarantee). Registered via
// `node --import`, it replaces `global.fetch` with a thrower carrying a stable
// marker. A Class-C server-down-safe command (`dev db migrate`, `dev setup`)
// must NEVER take a HARD dependency on reaching the running instance over the
// network — so it must fail on a DB/checkout reason, never surface this marker.
const POISON = "__FETCH_POISON_REACHED__";

globalThis.fetch = async () => {
  throw new Error(POISON);
};
