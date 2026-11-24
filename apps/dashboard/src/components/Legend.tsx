export function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-sm font-normal text-kumo-subtle">
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
