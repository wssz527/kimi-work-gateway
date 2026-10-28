export const structuralKernel = `
const createDecorator = value => Symbol.for(value);
const IAgentProfileService = createDecorator("agentProfileService");
const ErrorCodes = { AGENT_NOT_FOUND: "missing" };
class Error2 extends Error {}
function runAgentTurn(handle, request, options) { return request; }
export class Config {
  constructor(homeDir) { this.bootstrap = { homeDir }; this.memory = {}; }
  freshEffective() { return {}; }
  get(domain) {
    if (Object.prototype.hasOwnProperty.call(this.memory, domain)) return this.memory[domain];
    return this.freshEffective()[domain];
  }
}
export class Dispatcher {
  constructor(config, handle) { this.configService = config; this.agentLifecycle = { handleOf: () => handle }; }
  requireCaller(id) { return id; }
  async planSpawn(input) {
    const caller = this.requireCaller(input.callerAgentId);
    return caller;
  }
  run(agent, request, opts) {
    const handle = this.agentLifecycle.handleOf(agent.agentId);
    if (handle === void 0) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, "Agent missing", { details: { agentId: agent.agentId } });
    return runAgentTurn(handle, request, { signal: opts.signal, onReady: opts.onReady });
  }
}
`;
