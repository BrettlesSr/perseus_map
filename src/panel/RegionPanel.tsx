import type { SystemView, World } from "../data/load";
import type { SystemKind } from "../data/schema";

interface Props {
  world: World;
  regionId: string;
  onSelectSystem: (id: string) => void;
  onClose: () => void;
}

const kindOrder: SystemKind[] = ["major", "npc", "hostile", "empty"];
const statLabel: Record<SystemKind, string> = { major: "major power", npc: "NPC", hostile: "hostile", empty: "empty" };
const kindHeading: Record<SystemKind, string> = {
  major: "Major power systems",
  npc: "NPC systems",
  hostile: "Hostile NPC systems",
  empty: "Empty systems",
};

export function RegionPanel({ world, regionId, onSelectSystem, onClose }: Props) {
  const region = world.regions.get(regionId);
  if (!region) return null;
  const systems = region.systems.map((id) => world.systems.get(id)).filter((s) => s !== undefined);

  const byKind = new Map<SystemKind, SystemView[]>();
  for (const s of systems) byKind.set(s.kind ?? "empty", [...(byKind.get(s.kind ?? "empty") ?? []), s]);

  // nations with any presence here, most systems first
  const nationCounts = new Map<string, number>();
  for (const s of systems) for (const p of s.presence) nationCounts.set(p.nation.id, (nationCounts.get(p.nation.id) ?? 0) + 1);
  const nations = [...nationCounts].sort((a, b) => b[1] - a[1]);

  return (
    <aside className="panel" aria-label={`${region.name} region`}>
      <header className="panel__header">
        <div>
          <p className="panel__eyebrow">Region</p>
          <h2 className="panel__title">{region.name}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </header>

      {region.info?.description && <p className="panel__desc">{region.info.description}</p>}
      {!region.info && <p className="panel__muted">No details on record yet ({region.geo.id}).</p>}

      <ul className="stat-row" aria-label="Systems by kind">
        <li>
          <strong>{systems.length}</strong> systems
        </li>
        {kindOrder
          .filter((k) => byKind.get(k)?.length)
          .map((k) => (
            <li key={k} className={`kind kind--${k}`}>
              <strong>{byKind.get(k)!.length}</strong> {statLabel[k]}
            </li>
          ))}
      </ul>

      {nations.length > 0 && (
        <section>
          <h3 className="panel__section">Nations present</h3>
          <ul className="chip-list">
            {nations.map(([id, n]) => {
              const nation = world.nations.get(id)!;
              return (
                <li key={id} className="chip chip--static" style={{ borderColor: nation.color }}>
                  {nation.name} · {n}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {kindOrder.map((k) => {
        const list = (byKind.get(k) ?? []).filter((s) => s.info?.name);
        if (!list.length) return null;
        return (
          <section key={k}>
            <h3 className="panel__section">{kindHeading[k]}</h3>
            <ul className="chip-list">
              {list
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((s) => (
                  <li key={s.geo.id}>
                    <button className={`chip kind-chip kind-chip--${k}`} onClick={() => onSelectSystem(s.geo.id)}>
                      {s.name}
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        );
      })}
      {(() => {
        const unnamed = systems.filter((s) => !s.info?.name).length;
        return unnamed ? <p className="panel__muted">…and {unnamed} unnamed waypoint{unnamed === 1 ? "" : "s"}.</p> : null;
      })()}
    </aside>
  );
}
