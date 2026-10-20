import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, useUi } from "../store/ui";
import { resetAudioForTests } from "../alerts/deliver";
import { Settings } from "./Settings";

describe("Settings alerts", () => {
  const request = vi.fn();
  beforeEach(() => {
    window.localStorage.clear();
    request.mockReset().mockResolvedValue("granted");
    useUi.setState({ settings: DEFAULT_SETTINGS });
    vi.stubGlobal("Notification", { permission: "default", requestPermission: request });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests permission from the toggle (a user gesture) and shows the result", async () => {
    render(<Settings />);
    expect(screen.getByTestId("notification-permission")).toHaveTextContent("not asked yet");
    await userEvent.click(screen.getByLabelText(/browser notifications/i));
    expect(request).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/permission: granted/i)).toBeInTheDocument();
  });

  it("does not ask when turning the toggle off, and explains a blocked permission", async () => {
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: request });
    render(<Settings />);
    expect(screen.getByTestId("notification-permission")).toHaveTextContent("blocked");
    await userEvent.click(screen.getByLabelText(/browser notifications/i));
    expect(request).not.toHaveBeenCalled();
  });

  it("saves per-state sounds and the mute, and loads old settings without them", async () => {
    vi.stubGlobal("AudioContext", undefined);
    render(<Settings />);
    await userEvent.click(screen.getByLabelText(/tone when a session needs input/i));
    await userEvent.click(screen.getByLabelText(/mute all tones/i));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(loadSettings()).toMatchObject({
      sounds: { waiting_permission: false, waiting_input: true },
      muted: true,
    });
    window.localStorage.setItem(
      "sd.settings",
      JSON.stringify({ hubUrl: "x", notifications: true }),
    );
    expect(loadSettings().sounds).toEqual({ waiting_permission: false, waiting_input: false });
  });

  it("previews a tone on enabling, but not while globally muted", async () => {
    const created: number[] = [];
    class FakeAudio {
      currentTime = 0;
      destination = {};
      resume = () => Promise.resolve();
      createOscillator() {
        return {
          frequency: { value: 0 },
          connect: () => undefined,
          start: () => created.push(1),
          stop: () => undefined,
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
          connect: () => undefined,
        };
      }
    }
    vi.stubGlobal("AudioContext", FakeAudio);
    resetAudioForTests();
    render(<Settings />);
    await userEvent.click(screen.getByLabelText(/tone when a session needs input/i));
    expect(created).toHaveLength(1);
    await userEvent.click(screen.getByLabelText(/mute all tones/i));
    await userEvent.click(screen.getByLabelText(/tone when a session needs permission/i));
    expect(created).toHaveLength(1);
  });
});
