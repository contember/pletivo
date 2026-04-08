import { useState, type ReactNode } from 'react';

export default function Wrapper({ children, title = 'Wrapper' }: { children?: ReactNode; title?: string }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="wrapper" data-title={title}>
      <button onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Collapse' : 'Expand'}
      </button>
      {expanded && <div className="wrapper-content">{children}</div>}
    </div>
  );
}
