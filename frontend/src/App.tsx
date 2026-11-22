import { useEffect, useMemo, useState } from "react";
import { api, clearToken, getToken, streamUrl } from "./api";
import { useSSE } from "./hooks/useSSE";
import type { Command } from "./types";
import Login from "./components/Login";
import CommandList from "./components/CommandList";
import CommandDetail from "./components/CommandDetail";
import CallPanel from "./components/CallPanel";

export default function App() {
  const [token, setToken] = useState<string | null>(() => getToken());

  if (!token) {
    return <Login onLogin={setToken} />;
  }

  return (
    <Dashboard
      onLogout={() => {
        clearToken();
        setToken(null);
      }}
    />
  );
}

interface DashboardProps {
  onLogout: () => void;
}

function Dashboard({ onLogout }: DashboardProps) {
  const [commands, setCommands] = useState<Command[]>([]);
  const [purchases, setPurchases] = useState<Awaited<ReturnType<typeof api.getPurchases>>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"commands" | "call">("commands");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.getCommands(), api.getPurchases()])
      .then(([loadedCommands, loadedPurchases]) => {
        if (!active) return;
        setCommands(loadedCommands);
        setPurchases(loadedPurchases);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to load data");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function handleStream(incoming: Command) {
    if (!incoming || !incoming.id) return;
    setCommands((current) =>
      current.some((command) => command.id === incoming.id)
        ? current
        : [incoming, ...current],
    );
  }

  const streamStatus = useSSE<Command>(streamUrl(), handleStream);

  const newCommands = useMemo(
    () => commands.filter((command) => command.status !== "processed" && command.status !== "pending" && command.approved == null),
    [commands],
  );
  const pendingCommands = useMemo(
    () => commands.filter((command) => command.status === "pending"),
    [commands],
  );
  const processedCommands = useMemo(
    () => commands.filter((command) => command.status === "processed" || command.approved != null),
    [commands],
  );
  const selectedCommand = useMemo(
    () => commands.find((command) => command.id === selectedId) ?? null,
    [commands, selectedId],
  );

  function selectCommand(id: string) {
    setSelectedId(id);
    setTab("commands");
  }

  async function decideCommand(id: string, approve: boolean) {
    setBusyId(id);
    setError("");
    try {
      const updated = await api.approveCommand(id, approve);
      const resolved: Command = {
        ...updated,
        id: updated.id || id,
        status: "processed",
        approved: approve,
      };
      setCommands((current) => current.map((command) => (command.id === id ? resolved : command)));
      setSelectedId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function decidePurchase(id: string, approve: boolean) {
    setBusyId(id);
    setError("");
    try {
      await api.approvePurchase(id, approve);
      setPurchases((current) => current.filter((purchase) => purchase.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>Stockline</span>
        </div>
        <div className="topbar-right">
          <span className={`stream-pill ${streamStatus}`}>
            {streamStatus === "open" ? "Live feed" : streamStatus === "connecting" ? "Connecting" : "Reconnecting"}
          </span>
          <button className="button ghost" type="button" onClick={onLogout}>Logout</button>
        </div>
      </header>

      {error && <div className="banner error-banner">{error}</div>}

      <div className="layout">
        <aside className="sidebar">
          {loading && <p className="empty">Loading data...</p>}

          <CommandList
            title="New"
            commands={newCommands}
            selectedId={selectedId}
            onSelect={selectCommand}
            emptyMessage="No new commands"
            accent="green"
          />

          <section className="list-section">
            <h2 className="list-title">
              <span>Pending</span>
              <span className="count amber">{pendingCommands.length + purchases.length}</span>
            </h2>
            <div className="list-body">
              {pendingCommands.length === 0 && purchases.length === 0 && (
                <p className="empty">Nothing awaiting approval</p>
              )}
              {pendingCommands.map((command) => (
                <button
                  key={`cmd-${command.id}`}
                  type="button"
                  className={`list-item${command.id === selectedId ? " selected" : ""}`}
                  onClick={() => selectCommand(command.id)}
                >
                  <span className="item-primary">{command.client_name || command.client_id}</span>
                  <span className="item-secondary">Command - {command.status}</span>
                  <span className="item-meta">{command.order_lines?.length ?? 0} lines</span>
                </button>
              ))}
              {purchases.map((purchase) => (
                <div key={`pur-${purchase.id}`} className="list-item purchase-item">
                  <span className="item-primary">{purchase.article_name || purchase.product_id}</span>
                  <span className="item-secondary">
                    Qty {purchase.quantity} - {purchase.price}
                  </span>
                  <div className="inline-actions">
                    <button
                      className="button tiny reject"
                      type="button"
                      disabled={busyId === purchase.id}
                      onClick={() => decidePurchase(purchase.id, false)}
                    >
                      Reject
                    </button>
                    <button
                      className="button tiny approve"
                      type="button"
                      disabled={busyId === purchase.id}
                      onClick={() => decidePurchase(purchase.id, true)}
                    >
                      Approve
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <CommandList
            title="Processed"
            commands={processedCommands}
            selectedId={selectedId}
            onSelect={selectCommand}
            emptyMessage="Nothing processed yet"
            accent="blue"
          />
        </aside>

        <main className="main-panel">
          <nav className="tabs">
            <button
              type="button"
              className={tab === "commands" ? "active" : ""}
              onClick={() => setTab("commands")}
            >
              Commands
            </button>
            <button
              type="button"
              className={tab === "call" ? "active" : ""}
              onClick={() => setTab("call")}
            >
              Live call
            </button>
          </nav>

          {tab === "commands" ? (
            <CommandDetail
              command={selectedCommand}
              onDecision={decideCommand}
              busy={busyId !== null && busyId === selectedId}
            />
          ) : (
            <CallPanel />
          )}
        </main>
      </div>
    </div>
  );
}
