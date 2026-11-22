import type { Command } from "../types";

interface CommandListProps {
  title: string;
  commands: Command[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyMessage: string;
  accent?: "green" | "blue" | "gray";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function CommandList({
  title,
  commands,
  selectedId,
  onSelect,
  emptyMessage,
  accent = "gray",
}: CommandListProps) {
  return (
    <section className="list-section">
      <h2 className="list-title">
        <span>{title}</span>
        <span className={`count ${accent}`}>{commands.length}</span>
      </h2>
      <div className="list-body">
        {commands.length === 0 && <p className="empty">{emptyMessage}</p>}
        {commands.map((command) => (
          <button
            key={command.id}
            type="button"
            className={`list-item${command.id === selectedId ? " selected" : ""}`}
            onClick={() => onSelect(command.id)}
          >
            <span className="item-primary">{command.client_name || command.client_id}</span>
            <span className="item-secondary">{formatDate(command.recorded_at)}</span>
            <span className="item-meta">{command.order_lines?.length ?? 0} lines</span>
          </button>
        ))}
      </div>
    </section>
  );
}
