import { useMemo, useState } from "react";
import type { World } from "../data/load";

interface Props {
  world: World;
  onSelectSystem: (id: string) => void;
  onSelectRegion: (id: string) => void;
  onFocusNation: (id: string) => void;
}

type Result = { kind: "system" | "nation" | "region"; id: string; label: string; sub: string };

/** Find a system or nation by name and jump to it. */
export function Search({ world, onSelectSystem, onSelectRegion, onFocusNation }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const index = useMemo<Result[]>(
    () => [
      ...[...world.regions.values()].map((r) => ({
        kind: "region" as const,
        id: r.geo.id,
        label: r.name,
        sub: `Region · ${r.systems.length} systems`,
      })),
      ...[...world.nations.values()].map((n) => ({
        kind: "nation" as const,
        id: n.id,
        label: n.name,
        sub: n.player ? `Nation · ${n.player}` : "Nation",
      })),
      ...[...world.systems.values()].filter((s) => s.info?.name).map((s) => ({
        kind: "system" as const,
        id: s.geo.id,
        label: s.name,
        sub: s.presence.length ? s.presence.map((p) => p.nation.name).join(", ") : "System",
      })),
    ],
    [world],
  );

  const q = query.trim().toLowerCase();
  const results = q ? index.filter((r) => r.label.toLowerCase().includes(q) || r.id === q).slice(0, 8) : [];

  const choose = (r: Result) => {
    if (r.kind === "system") onSelectSystem(r.id);
    else if (r.kind === "region") onSelectRegion(r.id);
    else onFocusNation(r.id);
    setQuery("");
  };

  return (
    <div className="search" role="combobox" aria-expanded={results.length > 0} aria-haspopup="listbox">
      <input
        className="search__input"
        type="search"
        placeholder="Search systems, regions, nations…"
        value={query}
        aria-label="Search systems, regions or nations"
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && results[active]) choose(results[active]);
          else if (e.key === "Escape") setQuery("");
          else return;
          e.preventDefault();
        }}
      />
      {results.length > 0 && (
        <ul className="search__results" role="listbox">
          {results.map((r, i) => (
            <li key={`${r.kind}:${r.id}`} role="option" aria-selected={i === active}>
              <button
                className={`search__result${i === active ? " search__result--active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(r)}
              >
                <span>{r.label}</span>
                <small>{r.sub}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
