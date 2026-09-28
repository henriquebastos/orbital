import { OrbitalError, type AllocationRequest, type ExecRequest, type ExecResult, type OrbSnapshot, type Provider } from "@henriquebastosnet/orbital";

export class SimulatedProvider implements Provider {
  orbs: OrbSnapshot[] = [];
  files = new Map<string, Uint8Array>();
  effects: string[] = [];
  fault?: "reject" | "lose_command" | "lose_write";
  beforeRead?: () => Promise<void>;
  async resolve(orbId: string) { return this.orbs.find(orb => orb.orbId === orbId); }
  async create(request: AllocationRequest) {
    const orb: OrbSnapshot = { ...request, resourceId: `allocation-${this.orbs.length + 1}`, state: "running" };
    this.orbs.push(orb);
    this.effects.push(`create:${orb.resourceId}`);
    return orb;
  }
  async resume(orb: OrbSnapshot) { orb.state = "running"; this.effects.push(`resume:${orb.resourceId}`); }
  async delete(orb: OrbSnapshot) { this.orbs = this.orbs.filter(item => item.resourceId !== orb.resourceId); }
  url(orb: OrbSnapshot, port: number) { return `https://${port}-${orb.resourceId}.example.test`; }
  async exec(orb: OrbSnapshot, request: ExecRequest & { orbCwd: string }): Promise<ExecResult> {
    if (this.fault === "reject") throw new OrbitalError("not_started", "denied", "Execution was denied.");
    this.effects.push(`exec:${orb.resourceId}:${request.command}`);
    if (this.fault === "lose_command") throw new OrbitalError("uncertain", "transport", "Command outcome is unknown.", { stdout: "partial", jobId: "job-1" });
    return { kind: "exited", exitCode: 0, jobId: "job-1", stdout: request.command === "pwd" ? request.orbCwd : "remote", stderr: "", outputPath: "/home/user/.orbital/jobs/job-1/output" };
  }
  async readFile(orb: OrbSnapshot, path: string) {
    await this.beforeRead?.();
    const content = this.files.get(`${orb.resourceId}:${path}`);
    if (!content) throw new OrbitalError("not_started", "missing_file", "The remote file does not exist.");
    return content;
  }
  async writeFile(orb: OrbSnapshot, path: string, content: Uint8Array) {
    if (this.fault === "reject") throw new OrbitalError("not_started", "denied", "The write was denied before admission.");
    this.files.set(`${orb.resourceId}:${path}`, content);
    this.effects.push(`write:${orb.resourceId}:${path}`);
    if (this.fault === "lose_write") throw new OrbitalError("uncertain", "transport", "Write outcome is unknown.");
  }
  async stat(_orb: OrbSnapshot, path: string) {
    if (path !== "/home/user") throw new OrbitalError("not_started", "missing_file", "The remote path does not exist.");
    return { kind: "directory" as const, size: 0 };
  }
}
