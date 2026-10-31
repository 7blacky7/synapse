import type { EntityViewModel } from '../../control-plane/view-model';

export function EntityDetail({ entity }: { entity: EntityViewModel }) {
  return (
    <div className="entity-detail">
      <div className="detail-status"><i className={entity.statusTone} /><span>{entity.status}</span><b>{entity.source === 'api' ? 'LIVE' : 'MOCK'}</b></div>
      <h2>{entity.title}</h2>
      <p>{entity.subtitle}</p>
      <dl>
        {entity.details.map((detail) => (
          <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>
        ))}
      </dl>
    </div>
  );
}
