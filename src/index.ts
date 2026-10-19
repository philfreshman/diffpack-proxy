import { createProxy } from "./lib/proxy";

export default createProxy({ fetch: fetch.bind(globalThis) });
