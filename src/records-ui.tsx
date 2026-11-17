import type * as ReactRuntime from "react";
import type { MeetingRecords } from "./meeting-records";
export function recordsUI(React: typeof ReactRuntime, records: MeetingRecords, openThread?: (channelId: string, messageId: string) => void) {
  const statusLabel: Record<string, string> = { done: "Done", working: "Working", blocked: "Needs attention", proposed: "Proposed" };
  return function Records({ channelId }: { channelId: string }) {
    const state = React.useSyncExternalStore(records.subscribe,records.snapshot);
    const [selected,setSelected] = React.useState(""), [text,setText] = React.useState(""), [error,setError] = React.useState("");
    const entries = state.records.filter(record => record.value.channelId === channelId), record = entries.find(record => record.id === selected);
    React.useEffect(() => {
      setText(""); setError(""); let current = true;
      if (record) void records.read(record.id).then(value => { if (current) setText(value); }).catch(problem => { if (current) setError(problem.message); });
      return () => { current=false; };
    },[selected,channelId,record?.id]);
    return <section className="meeting-records text-body-sm" aria-label="Saved meeting records"><h3>Meeting records</h3>
      {!entries.length && <p className="text-subtle">Save a transcript during or after a call to keep its speakers, times and task results here.</p>}
      {entries.map(record => <button type="button" key={record.id} className="buzz-button meeting-record-choice" data-buzz-ui="" data-variant="ghost" aria-pressed={selected===record.id} onClick={() => setSelected(record.id)}>{record.value.title} · {new Date(record.value.capturedAt).toLocaleString()}</button>)}
      {record && <article>{record.value.warning && <p className="text-subtle">{record.value.warning}</p>}{record.value.tasks.length > 0 && <ul className="meeting-record-tasks" aria-label="Meeting results">{record.value.tasks.map((task,index) => <li key={index}><strong>{task.title}</strong> · {statusLabel[task.status] ?? task.status}{task.author && <> · {task.author.name}</>}{task.result && <> — {task.result}</>}{task.messageId && openThread && <> <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={() => openThread(record.value.channelId, task.messageId!)}>Open result in thread</button></>}</li>)}</ul>}{error ? <p role="alert" className="text-danger">{error}</p> : <pre className="meeting-record-text">{text || "Loading transcript…"}</pre>}</article>}
      {state.error && <p role="alert" className="text-danger">{state.error}</p>}
      {state.pending && <button type="button" className="buzz-button" data-buzz-ui="" disabled={state.busy} onClick={() => { void records.retry(); }}>Check / retry saved meeting</button>}
    </section>;
  };
}
