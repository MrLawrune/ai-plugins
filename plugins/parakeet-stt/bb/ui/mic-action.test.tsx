import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { followBottom } from "../follow-bottom.ts";
import { MicAction } from "./mic-action.tsx";

vi.mock("../follow-bottom.ts", () => ({ followBottom: vi.fn() }));
vi.mock("./hooks.ts", () => ({
  useControllerDeps: () => {},
  useComposerTarget: () => "k1",
  useDictationState: () => ({ phase: "idle", targetId: null, startedAt: null, waiting: false, heard: null }),
  usePress: () => ({ down() {}, up() {}, cancel() {} }),
}));

test("the mic button never follows the editor itself: that belongs to a dictation session", () => {
  render(
    <form data-promptbox>
      <div data-promptbox-compact-content><div className="ProseMirror" /></div>
      <MicAction />
    </form>,
  );
  expect(followBottom).not.toHaveBeenCalled();
});
