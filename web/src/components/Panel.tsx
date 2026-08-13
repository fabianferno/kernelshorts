export function Panel({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded border border-line bg-panel ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-muted">
          {title}
        </h2>
        {right ? <div className="text-dim">{right}</div> : null}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** Used wherever a section of the artifact viewer has nothing behind it. It says
 *  which collection was empty, because "nothing here" and "we never wrote it"
 *  are different bugs. */
export function Absent({ what }: { what: string }) {
  return <p className="text-dim italic">not recorded — {what}</p>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[11px] uppercase tracking-wider text-dim">{label}</div>
      <div className="text-fg">{children}</div>
    </div>
  );
}
