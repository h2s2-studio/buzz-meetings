import type * as ReactRuntime from "react";

// Buzz's approved RobotArtwork, adapted to the injected React runtime.
// block/buzz-app a1c9c969, Apache-2.0; see THIRD_PARTY_NOTICES.
export function agentIcon(React: typeof ReactRuntime) {
  return function AgentIcon() {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.75" y="7" width="14.5" height="13.25" rx="4.5" />
      <path d="M12 7V2.5M3.25 11.5v4.25M20.75 11.5v4.25" />
      <g fill="currentColor" stroke="none"><circle cx="9" cy="13.25" r="1.4" /><circle cx="15" cy="13.25" r="1.4" /></g>
    </svg>;
  };
}
