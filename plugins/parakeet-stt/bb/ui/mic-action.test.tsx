import { render } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { followBottom } from "../follow-bottom.ts";
import { MicAction } from "./mic-action.tsx";

vi.mock("../follow-bottom.ts", () => ({ followBottom: vi.fn() }));
const composer = { layout: "compact" as "compact" | "expanded" };
const prefs = { expandCompactDraft: true };
vi.mock("@get-bb/plugin-sdk/app", async (orig) => ({ ...(await orig<object>()), useComposer: () => composer }));
vi.mock("./hooks.ts", () => ({
  useControllerDeps: () => {},
  useComposerTarget: () => "k1",
  useDictationState: () => ({ phase: "idle", targetId: null, startedAt: null, waiting: false, heard: null }),
  usePress: () => ({ down() {}, up() {}, cancel() {} }),
  usePrefs: () => prefs,
}));

/** The bb composer structure around the mic button. */
function mount() {
  return render(
    <form data-promptbox>
      <div data-promptbox-compact-content><div className="ProseMirror" /></div>
      <MicAction />
    </form>,
  );
}

beforeEach(() => {
  vi.mocked(followBottom).mockClear();
  composer.layout = "compact";
  prefs.expandCompactDraft = true;
});

test("a compact composer with expanded drafts follows the bottom of its own editor", () => {
  const { container, unmount } = mount();
  const editor = container.querySelector(".ProseMirror");
  expect(followBottom).toHaveBeenCalledTimes(1);
  const [el, signal] = vi.mocked(followBottom).mock.calls[0]!;
  expect(el).toBe(editor);
  expect(signal.aborted).toBe(false);
  unmount();
  expect(signal.aborted).toBe(true);
});

test("an expanded composer follows nothing", () => {
  composer.layout = "expanded";
  mount();
  expect(followBottom).not.toHaveBeenCalled();
});

test("with expandCompactDraft off nothing is followed", () => {
  prefs.expandCompactDraft = false;
  mount();
  expect(followBottom).not.toHaveBeenCalled();
});
