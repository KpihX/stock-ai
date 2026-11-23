import type { Command } from "../types";

interface CommandDetailProps {
  command: Command | null;
  onDecision: (id: string, approve: boolean) => void;
  busy?: boolean;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function CommandDetail({ command, onDecision, busy }: CommandDetailProps) {
  if (!command) {
    return (
      <div className="detail-empty">
        <div className="detail-empty-icon">S</div>
        <p>Select a command to inspect its order lines.</p>
      </div>
    );
  }

  const lines = command.order_lines ?? [];
  const total = lines.reduce(
    (sum, line) => sum + Number(line.quantity || 0) * Number(line.daily_price ?? line.price ?? 0),
    0,
  );
  const cmdId = command.id || command.command_id;

  return (
    <div className="detail">
      <div className="detail-header">
        <div>
          <h2>Command {command.command_id || command.id}</h2>
          <p className="muted">
            {command.client_name || command.client_id}
            {command.phone_number ? ` - ${command.phone_number}` : ""}
          </p>
        </div>
        <div className="detail-actions">
          <button
            className="button reject"
            type="button"
            disabled={busy}
            onClick={() => onDecision(cmdId, false)}
          >
            Reject
          </button>
          <button
            className="button approve"
            type="button"
            disabled={busy}
            onClick={() => onDecision(cmdId, true)}
          >
            Approve
          </button>
        </div>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>Client ID</dt>
          <dd>{command.client_id}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{command.recorded_at ? formatDate(command.recorded_at) : "-"}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd>{command.delivery_date || "-"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{command.status ?? "new"}</dd>
        </div>
      </dl>

      <div className="table-wrap">
        <table className="lines-table">
          <thead>
            <tr>
              <th>Article</th>
              <th>Article ID</th>
              <th>Quantity</th>
              <th>Daily price</th>
              <th>Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const unitPrice = Number(line.daily_price ?? line.price ?? 0);
              return (
                <tr key={`${line.article_id || line.product_id || "line"}-${index}`}>
                  <td>{line.article_name || line.product_id}</td>
                  <td>{line.article_id || line.product_id}</td>
                  <td>{line.quantity}</td>
                  <td>{unitPrice}</td>
                  <td>{(line.quantity * unitPrice).toFixed(2)}</td>
                </tr>
              );
            })}
            {lines.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">No order lines</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="detail-total">
        <span>Total</span>
        <strong>{total.toFixed(2)}</strong>
      </div>
    </div>
  );
}
