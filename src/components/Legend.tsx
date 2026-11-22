export function Legend({ color, label, ring = false }: { color: string; label: string; ring?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-sm font-normal text-kumo-subtle">
      <span className="size-2.5 shrink-0 rounded-full" style={ring ? { boxShadow: `inset 0 0 0 2px ${color}` } : { background: color }} />
      {label}
    </span>
  );
}
