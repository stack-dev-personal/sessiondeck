import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "@sessiondeck/contract";
import { AgentRollup } from "./AgentRollup";

const agent = {
  agent_id: "agent-0123456789abcdef",
  agent_type: "general-purpose-very-long-type-name",
  parent_agent_id: null,
  model: null,
  tokens: null,
  started_at: 0,
  ended_at: null,
} as unknown as SubagentSnapshot;

describe("AgentRollup", () => {
  it("truncates the type, never the id", () => {
    render(<AgentRollup agents={[agent]} />);
    const card = screen.getByTestId("agent-card");
    const id = card.querySelector('[data-slot="id"]')!;
    const type = card.querySelector('[data-slot="type"]')!;
    expect(id.className).toContain("shrink-0");
    expect(id.className).not.toContain("truncate");
    expect(id.textContent).toBe(agent.agent_id);
    expect(type.className).toContain("truncate");
  });
});
