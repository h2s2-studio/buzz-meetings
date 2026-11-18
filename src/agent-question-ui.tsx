import type * as ReactRuntime from "react";
import type { Answer, LiveAgents } from "./live-agents";

/** An agent as any tile shows it: local (this device runs it) or seen through another participant's client. */
export type TileAgent = {
  pubkey: string; name: string; local: boolean;
  status?: { state: "listening" | "working" | "needs-input" | "finished"; caption: string; messageId?: string };
  question?: { key: string; text: string; options: readonly string[]; expiresAt: number; askedAt?: number };
  suggestions?: readonly Answer[];
};

// In a call people talk and watch: an agent's question is answered on its tile, by
// clicking (its owner, on the device that runs it) or by saying an option (anyone).
export function agentQuestionUI(React: typeof ReactRuntime, liveAgents?: LiveAgents, /** This client's media identity, to recognise the owner's own speech. */ self?: () => string | undefined) {
  const { useEffect, useId, useState } = React;
  function useNow(active: boolean) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
    return now;
  }
  function AgentQuestion({ agent, compact = false }: { agent: TileAgent; compact?: boolean }) {
    const question = agent.question, now = useNow(!!question), id = useId();
    if (!question) return null;
    const left = Math.max(0, Math.ceil((question.expiresAt - now) / 1000));
    const heard = agent.suggestions?.at(-1);
    return <div className="meeting-agent-question" role="group" aria-label={`${agent.name} asks`} data-compact={compact || undefined}>
      <p className="meeting-agent-question-text" id={id}>{question.text}</p>
      <div className="meeting-agent-question-options">{question.options.map(option => agent.local
        ? <button key={option} type="button" aria-describedby={id} className="buzz-button" data-buzz-ui="" data-size="sm" data-variant={option === question.options[0] ? "prominent" : "subtle"} onClick={() => liveAgents?.answer(agent.pubkey, question.key, option)}>{option}</button>
        : <span key={option} className="meeting-agent-question-option">{option}</span>)}</div>
      {/* Announced only when something is heard; the countdown is not a live region. */}
      <p className="meeting-agent-question-meta text-caption">
        <span role="status">{heard ? `Heard “${heard.heard}” from ${heard.byName}. ${agent.local && heard.by === self?.() ? "Click to confirm." : `${agent.name} decides.`} ` : agent.local ? "Click or say an option. " : "Say an option to answer. "}</span>
      </p>
      {/* A thin draining line (styled by the design pass) instead of a ticking number. */}
      <span className="meeting-agent-question-timer" aria-hidden="true" title={left > 0 ? `Closes in ${left} s` : "Closing"} style={{ "--remaining": String(Math.max(0, Math.min(1, (question.expiresAt - now) / Math.max(1, question.expiresAt - (question.askedAt ?? now))))) } as ReactRuntime.CSSProperties} />
    </div>;
  }
  const label: Record<string, string> = { listening: "Listening", working: "Working", "needs-input": "Needs input", finished: "Finished" };
  function AgentStatusLine({ agent, openResult }: { agent: TileAgent; openResult?(messageId: string): void }) {
    const status = agent.status;
    if (!status) return null;
    return <span className="meeting-agent-status text-caption" data-state={status.state}>
      <span className="meeting-agent-status-state">{label[status.state]}</span>{status.caption && status.state !== "listening" && <span className="meeting-agent-status-caption"> · {status.caption}</span>}
      {agent.local && status.messageId && openResult && <button type="button" className="buzz-button" data-buzz-ui="" data-size="sm" data-variant="ghost" onClick={event => { event.stopPropagation(); openResult(status.messageId!); }}>Open result</button>}
    </span>;
  }
  return { AgentQuestion, AgentStatusLine };
}
