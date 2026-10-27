export interface ExeTarget {
  dir: string;
  ext: string;
  cross: boolean;
}
export function selectTargets(
  platform: string,
  opts?: { hostOnly?: boolean },
): { targets: ExeTarget[]; notices: string[]; includeFloor: boolean };
