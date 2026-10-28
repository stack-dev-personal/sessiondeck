import { Link, useInRouterContext } from "react-router-dom";
import { ProjectSwatch } from "./ProjectSwatch";

/** Swatch + project name, linking to the project view when there is a router and a project id. */
export function ProjectLink({
  id,
  name,
  color,
  onNavigate,
}: {
  id: string | null | undefined;
  name: string | null | undefined;
  color: string | null | undefined;
  onNavigate?: () => void;
}) {
  const inRouter = useInRouterContext();
  const label = name ?? "n/a";
  return (
    <span className="flex min-w-0 items-center gap-s-2" data-testid="project-link">
      <ProjectSwatch color={color} />
      {inRouter && id ? (
        <Link
          to={`/projects/${encodeURIComponent(id)}`}
          onClick={onNavigate}
          className="min-w-0 truncate text-accent underline"
        >
          {label}
        </Link>
      ) : (
        <span className={`min-w-0 truncate ${name ? "" : "text-fg-muted"}`}>{label}</span>
      )}
    </span>
  );
}
