import { cssColor } from "../atlas/color";

/**
 * Small square in the project's color. Decoration only: the project name is always next to it.
 * The color reaches the style attribute only through the allow-listed token map or a validated #rrggbb.
 */
export function ProjectSwatch({
  color,
  className = "",
}: {
  color: string | null | undefined;
  className?: string;
}) {
  const css = cssColor(color);
  return (
    <span
      aria-hidden="true"
      data-slot="swatch"
      className={`inline-block size-2.5 shrink-0 rounded-sm border border-border-strong ${css === null ? "bg-surface-3" : ""} ${className}`}
      style={css === null ? undefined : { backgroundColor: css }}
    />
  );
}
