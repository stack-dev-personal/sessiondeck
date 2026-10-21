/** The probe-owned arguments `probe install` writes into hook and statusline commands. */
export interface ProbeArgs {
  home?: string;
  host?: string;
}

/** Reads `--home <dir>` and `--host <name>` (also `--flag=value`); ignores everything else. */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const out: ProbeArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    for (const name of ["home", "host"] as const) {
      const flag = `--${name}`;
      if (a === flag) {
        const v = argv[i + 1];
        if (v) out[name] = v;
        i += 1;
        break;
      }
      if (a.startsWith(`${flag}=`) && a.length > flag.length + 1) {
        out[name] = a.slice(flag.length + 1);
        break;
      }
    }
  }
  return out;
}
