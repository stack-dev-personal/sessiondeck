import { useMemo } from "react";
import { CompactCard, SessionCard } from "../components/SessionCard";
import { buildSpecimens } from "../dev/specimens";
import { useNow } from "../hooks/useNow";

/**
 * Gallery of every card state and threshold from fixtures (R3.2, R3.7). Lazy-loaded by App in
 * dev and mock builds only. Specimens are inert: no open handler is passed.
 */
export default function DevCards() {
  const now = useNow();
  const groups = useMemo(() => buildSpecimens(now), [now]);
  return (
    <div className="p-s-4" data-testid="dev-cards">
      <h1 className="m-0 mb-s-3 text-xl">/dev/cards</h1>
      {groups.map((g) => (
        <section key={g.id} className="mb-s-6" aria-labelledby={`g-${g.id}`}>
          <h2 id={`g-${g.id}`} className="mb-s-2 mt-0 text-md text-fg-muted">
            {g.title}
          </h2>
          <ul
            className={
              g.id === "states-compact"
                ? "m-0 flex list-none flex-col gap-s-1 p-0"
                : "m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(28rem,1fr))] gap-s-3 p-0"
            }
          >
            {g.specimens.map((sp) => (
              <li key={sp.id} data-testid={`specimen-${sp.id}`} className="min-w-0">
                <p className="num m-0 mb-s-1 text-xs text-fg-muted">{sp.label}</p>
                {g.id === "states-compact" ? (
                  <CompactCard s={sp.snapshot} now={now} exceeds200k={sp.exceeds200k} />
                ) : (
                  <SessionCard s={sp.snapshot} now={now} exceeds200k={sp.exceeds200k} />
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
