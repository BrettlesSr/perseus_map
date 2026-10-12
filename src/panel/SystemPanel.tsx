import { kindLabel, type World } from "../data/load";
import type { Nation } from "../data/schema";

interface Props {
  world: World;
  systemId: string;
  focusedNationId?: string;
  onSelectSystem: (id: string) => void;
  onSelectRegion: (id: string) => void;
  onFocusNation: (id: string | undefined) => void;
  onClose: () => void;
}

const roleLabel = { capital: "Capital", colony: "Colony", outpost: "Outpost", claim: "Claim" } as const;

export function SystemPanel(props: Props) {
  const { world, systemId, focusedNationId, onSelectSystem, onSelectRegion, onFocusNation, onClose } = props;
  const system = world.systems.get(systemId);
  if (!system) return null;
  const region = system.region ? world.regions.get(system.region) : undefined;

  return (
    <aside className="panel" aria-label={`${system.name} details`}>
      <header className="panel__header">
        <div>
          <p className="panel__eyebrow">System</p>
          <h2 className="panel__title">{system.name}</h2>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </header>

      {(system.kind || region) && (
        <div className="badge-row">
          {system.kind && <span className={`kind-badge kind-badge--${system.kind}`}>{kindLabel[system.kind]}</span>}
          {region && (
            <button className="chip chip--region" onClick={() => onSelectRegion(region.geo.id)}>
              {region.name}
            </button>
          )}
        </div>
      )}

      {system.info?.description && <p className="panel__desc">{system.info.description}</p>}
      {!system.info?.name && <p className="panel__muted">No name on record yet ({system.geo.id}).</p>}

      <section>
        <h3 className="panel__section">Nations present</h3>
        {system.presence.length === 0 ? (
          <p className="panel__muted">Unclaimed.</p>
        ) : (
          <ul className="nation-list">
            {system.presence.map(({ nation, role }) => (
              <NationCard
                key={nation.id}
                nation={nation}
                role={roleLabel[role]}
                systemCount={world.nationSystems.get(nation.id)?.length ?? 0}
                focused={focusedNationId === nation.id}
                onFocus={() => onFocusNation(focusedNationId === nation.id ? undefined : nation.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {system.neighbors.length > 0 && (
        <section>
          <h3 className="panel__section">Hyperlanes to</h3>
          <ul className="chip-list">
            {system.neighbors
              .map((id) => world.systems.get(id))
              .filter((s) => s !== undefined)
              // named systems first, then unnamed waypoints by id
              .sort((a, b) => Number(!a.info?.name) - Number(!b.info?.name) || a.name.localeCompare(b.name) || a.geo.id.localeCompare(b.geo.id))
              .map((n) => (
                <li key={n.geo.id}>
                  <button
                    className={`chip${n.info?.name ? "" : " chip--muted"}`}
                    style={n.ownerColor ? { borderColor: n.ownerColor } : undefined}
                    title={n.info?.name ? undefined : `Unnamed system ${n.geo.id}`}
                    onClick={() => onSelectSystem(n.geo.id)}
                  >
                    {n.info?.name || `Unnamed · ${n.geo.id.slice(4)}`}
                  </button>
                </li>
              ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

interface CardProps {
  nation: Nation;
  role: string;
  systemCount: number;
  focused: boolean;
  onFocus: () => void;
}

function NationCard({ nation, role, systemCount, focused, onFocus }: CardProps) {
  return (
    <li className="nation" style={{ borderLeftColor: nation.color }}>
      <div className="nation__head">
        {nation.flagUrl ? (
          <img className="nation__flag" src={nation.flagUrl} alt="" loading="lazy" />
        ) : (
          <span className="nation__flag nation__flag--blank" style={{ background: nation.color }} />
        )}
        <div className="nation__titles">
          <span className="nation__name">{nation.name}</span>
          <span className="nation__meta">
            {role}
            {nation.player && <> · played by {nation.player}</>}
          </span>
        </div>
      </div>
      {nation.description && <p className="nation__desc">{nation.description}</p>}
      <div className="nation__actions">
        <button className={`link-btn${focused ? " link-btn--on" : ""}`} onClick={onFocus}>
          {focused ? "Hide territory" : `Show territory (${systemCount})`}
        </button>
        {nation.forumUrl && (
          <a className="link-btn" href={nation.forumUrl} target="_blank" rel="noreferrer">
            Forum thread ↗
          </a>
        )}
      </div>
    </li>
  );
}
