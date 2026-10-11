import { act, render } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { followBottom } from "../follow-bottom.ts";
import { MicAction } from "./mic-action.tsx";

vi.mock("../follow-bottom.ts", () => ({ followBottom: vi.fn() }));
const composer = { layout: "compact" as "compact" | "expanded", key: "k1" };
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
const tree = (withEditor = true) => (
  <form data-promptbox>
    {withEditor && <div data-promptbox-compact-content><div className="ProseMirror" /></div>}
    <MicAction />
  </form>
);
const mount = () => render(tree());

beforeEach(() => {
  vi.mocked(followBottom).mockClear();
  composer.layout = "compact";
  composer.key = "k1";
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

test("turning the pref off stops following, turning it on follows again", () => {
  const { rerender } = mount();
  const first = vi.mocked(followBottom).mock.calls[0]![1];
  prefs.expandCompactDraft = false;
  rerender(tree());
  expect(first.aborted).toBe(true);
  expect(followBottom).toHaveBeenCalledTimes(1);
  prefs.expandCompactDraft = true;
  rerender(tree());
  expect(followBottom).toHaveBeenCalledTimes(2);
});

test("a different composer key re-attaches to the editor", () => {
  const { rerender } = mount();
  const first = vi.mocked(followBottom).mock.calls[0]![1];
  composer.key = "k2";
  rerender(tree());
  expect(first.aborted).toBe(true);
  expect(followBottom).toHaveBeenCalledTimes(2);
});

test("an editor that mounts a frame late is still followed", async () => {
  const { container, rerender } = render(tree(false));
  expect(followBottom).not.toHaveBeenCalled();
  rerender(tree(true)); // the effect does not re-run: only the retry can find it
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(followBottom).toHaveBeenCalledTimes(1);
  expect(vi.mocked(followBottom).mock.calls[0]![0]).toBe(container.querySelector(".ProseMirror"));
});

test("unmounting before the editor appears stops the retry", async () => {
  const { unmount } = render(tree(false));
  unmount();
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(followBottom).not.toHaveBeenCalled();
});
